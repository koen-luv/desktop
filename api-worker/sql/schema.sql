-- Liner self-hosted backend schema (Supabase / Postgres).
-- Run this once in the Supabase SQL editor. It is idempotent.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key,
  email text not null unique,
  username text unique,
  display_name text,
  avatar_url text,
  bio text,
  password_hash text not null,
  is_public boolean not null default false,
  show_activity boolean not null default true,
  show_history boolean not null default true,
  show_liked_tracks boolean not null default true,
  participate_leaderboards boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format
    check (username is null or username ~ '^[a-z0-9_]{3,30}$')
);

create table if not exists public.sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  refresh_token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists sessions_user_idx on public.sessions(user_id);

create table if not exists public.liked_tracks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  track_id text not null,
  track_json jsonb not null,
  liked_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create index if not exists liked_tracks_user_time_idx
  on public.liked_tracks(user_id, liked_at desc);

create table if not exists public.saved_collections (
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('albums', 'artists', 'playlists')),
  collection_id text not null,
  snapshot jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (user_id, kind, collection_id)
);

create index if not exists saved_collections_user_time_idx
  on public.saved_collections(user_id, saved_at desc);

create table if not exists public.user_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.playlists (
  id uuid primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text,
  is_public boolean not null default false,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists playlists_owner_time_idx
  on public.playlists(owner_id, updated_at desc);

create table if not exists public.playlist_items (
  id uuid primary key,
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  track_id text not null,
  track_json jsonb not null,
  position integer not null,
  added_at timestamptz not null default now()
);

create index if not exists playlist_items_order_idx
  on public.playlist_items(playlist_id, position);

create table if not exists public.playback_events (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  playback_session_id text not null,
  listening_session_id text not null,
  track_id text not null,
  track_json jsonb,
  played_duration_ms bigint not null default 0,
  track_duration_ms bigint,
  completion_rate real not null default 0,
  completed boolean not null default false,
  skipped boolean not null default false,
  loop_count integer not null default 0,
  has_seek_backward boolean not null default false,
  context jsonb,
  listened_at timestamptz not null default now(),
  unique (user_id, playback_session_id)
);

create index if not exists playback_events_user_time_idx
  on public.playback_events(user_id, listened_at desc);

create index if not exists playback_events_track_time_idx
  on public.playback_events(track_id, listened_at desc);

create index if not exists playback_events_time_idx
  on public.playback_events(listened_at desc);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_no_self check (follower_id <> following_id)
);

create index if not exists follows_following_idx
  on public.follows(following_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Auth RPCs: password hashing stays in Postgres (pgcrypto/bcrypt), which keeps
-- the Worker CPU tiny and never sends hashes to the client.
-- ---------------------------------------------------------------------------

create or replace function public.register_user(
  p_email text,
  p_password text,
  p_username text,
  p_display_name text
) returns setof public.profiles
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_profile public.profiles;
begin
  if exists (select 1 from public.profiles where email = lower(p_email)) then
    raise exception 'EMAIL_ALREADY_USED' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles where username = lower(p_username)) then
    raise exception 'USERNAME_TAKEN' using errcode = 'P0001';
  end if;

  insert into public.profiles (id, email, username, display_name, password_hash)
  values (
    gen_random_uuid(),
    lower(p_email),
    lower(p_username),
    p_display_name,
    extensions.crypt(p_password, extensions.gen_salt('bf', 10))
  )
  returning * into v_profile;

  return next v_profile;
end;
$$;

create or replace function public.login_user(
  p_email text,
  p_password text
) returns setof public.profiles
language sql
security definer
set search_path = public, extensions
as $$
  select *
  from public.profiles
  where email = lower(p_email)
    and password_hash = extensions.crypt(p_password, password_hash)
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Profiles / social
-- ---------------------------------------------------------------------------

create or replace function public.get_user_profile(
  p_key text,
  p_viewer_id uuid default null
) returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  bio text,
  is_public boolean,
  show_activity boolean,
  show_history boolean,
  show_liked_tracks boolean,
  participate_leaderboards boolean,
  created_at timestamptz,
  followers_count bigint,
  following_count bigint,
  is_following boolean
)
language sql
stable
as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.bio,
    p.is_public,
    p.show_activity,
    p.show_history,
    p.show_liked_tracks,
    p.participate_leaderboards,
    p.created_at,
    (select count(*) from public.follows f where f.following_id = p.id)::bigint,
    (select count(*) from public.follows f where f.follower_id = p.id)::bigint,
    (
      p_viewer_id is not null
      and exists (
        select 1 from public.follows f
        where f.follower_id = p_viewer_id and f.following_id = p.id
      )
    )
  from public.profiles p
  where p.id::text = p_key or p.username = lower(p_key)
  order by (p.id::text = p_key) desc
  limit 1;
$$;

create or replace function public.search_users(
  p_q text,
  p_limit integer default 20
) returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  bio text,
  is_public boolean,
  show_activity boolean,
  show_history boolean,
  show_liked_tracks boolean,
  participate_leaderboards boolean,
  created_at timestamptz,
  followers_count bigint,
  following_count bigint
)
language sql
stable
as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.bio,
    p.is_public,
    p.show_activity,
    p.show_history,
    p.show_liked_tracks,
    p.participate_leaderboards,
    p.created_at,
    (select count(*) from public.follows f where f.following_id = p.id)::bigint,
    (select count(*) from public.follows f where f.follower_id = p.id)::bigint
  from public.profiles p
  where p_q <> ''
    and (
      p.username ilike '%' || p_q || '%'
      or p.display_name ilike '%' || p_q || '%'
    )
  order by p.username nulls last
  limit greatest(1, least(p_limit, 50));
$$;

create or replace function public.user_followers(
  p_key text
) returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  bio text,
  is_public boolean,
  show_activity boolean,
  show_history boolean,
  show_liked_tracks boolean,
  participate_leaderboards boolean,
  created_at timestamptz,
  followers_count bigint,
  following_count bigint,
  is_following boolean
)
language sql
stable
as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.bio,
    p.is_public,
    p.show_activity,
    p.show_history,
    p.show_liked_tracks,
    p.participate_leaderboards,
    p.created_at,
    (select count(*) from public.follows f2 where f2.following_id = p.id)::bigint,
    (select count(*) from public.follows f2 where f2.follower_id = p.id)::bigint,
    false
  from public.follows f
  join public.profiles p on p.id = f.follower_id
  where f.following_id = (
    select id from public.profiles
    where id::text = p_key or username = lower(p_key)
    order by (id::text = p_key) desc
    limit 1
  )
  order by f.created_at desc
  limit 200;
$$;

create or replace function public.user_following(
  p_key text
) returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  bio text,
  is_public boolean,
  show_activity boolean,
  show_history boolean,
  show_liked_tracks boolean,
  participate_leaderboards boolean,
  created_at timestamptz,
  followers_count bigint,
  following_count bigint,
  is_following boolean
)
language sql
stable
as $$
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.bio,
    p.is_public,
    p.show_activity,
    p.show_history,
    p.show_liked_tracks,
    p.participate_leaderboards,
    p.created_at,
    (select count(*) from public.follows f2 where f2.following_id = p.id)::bigint,
    (select count(*) from public.follows f2 where f2.follower_id = p.id)::bigint,
    false
  from public.follows f
  join public.profiles p on p.id = f.following_id
  where f.follower_id = (
    select id from public.profiles
    where id::text = p_key or username = lower(p_key)
    order by (id::text = p_key) desc
    limit 1
  )
  order by f.created_at desc
  limit 200;
$$;

-- ---------------------------------------------------------------------------
-- Library writes
-- ---------------------------------------------------------------------------

create or replace function public.add_playlist_items(
  p_playlist_id uuid,
  p_tracks jsonb
) returns setof public.playlist_items
language plpgsql
as $$
declare
  v_next integer;
begin
  if jsonb_typeof(p_tracks) <> 'array' then
    raise exception 'INVALID_TRACKS' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_tracks) = 0 then
    return;
  end if;

  -- Serialize concurrent appends so two clients cannot claim the same slot.
  perform 1 from public.playlists where id = p_playlist_id for update;

  select coalesce(max(position), -1) + 1
  into v_next
  from public.playlist_items
  where playlist_id = p_playlist_id;

  return query
    with input as (
      select
        t.value as track,
        (t.ordinality - 1)::integer as offset
      from jsonb_array_elements(p_tracks) with ordinality as t(value, ordinality)
      where jsonb_typeof(t.value) = 'object'
        and coalesce(t.value ->> 'id', '') <> ''
        and coalesce(t.value ->> 'title', '') <> ''
    ),
    inserted as (
      insert into public.playlist_items
        (id, playlist_id, track_id, track_json, position, added_at)
      select
        gen_random_uuid(),
        p_playlist_id,
        input.track ->> 'id',
        input.track,
        v_next + input.offset,
        now()
      from input
      returning *
    )
    select * from inserted order by position;

  update public.playlists
  set revision = revision + 1, updated_at = now()
  where id = p_playlist_id;
end;
$$;

create or replace function public.remove_playlist_item(
  p_playlist_id uuid,
  p_item_id uuid
) returns void
language plpgsql
as $$
declare
  v_deleted integer;
begin
  perform 1 from public.playlists where id = p_playlist_id for update;

  delete from public.playlist_items
  where playlist_id = p_playlist_id and id = p_item_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;

  with ordered as (
    select
      id,
      (row_number() over (order by position, added_at) - 1)::integer as position
    from public.playlist_items
    where playlist_id = p_playlist_id
  )
  update public.playlist_items i
  set position = o.position
  from ordered o
  where i.id = o.id;

  update public.playlists
  set revision = revision + 1, updated_at = now()
  where id = p_playlist_id;
end;
$$;

create or replace function public.move_playlist_item(
  p_playlist_id uuid,
  p_item_id uuid,
  p_before_item_id uuid,
  p_revision integer
) returns jsonb
language plpgsql
as $$
declare
  v_revision integer;
  v_ids uuid[];
  v_new_ids uuid[] := '{}';
  v_id uuid;
  v_before_found boolean := false;
  v_playlist public.playlists;
begin
  select revision
  into v_revision
  from public.playlists
  where id = p_playlist_id
  for update;

  if not found then
    raise exception 'PLAYLIST_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_revision <> p_revision then
    raise exception 'REVISION_CONFLICT' using errcode = 'P0001';
  end if;

  select array_agg(id order by position, added_at)
  into v_ids
  from public.playlist_items
  where playlist_id = p_playlist_id;

  if v_ids is null or not (p_item_id = any(v_ids)) then
    raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_before_item_id is not null and not (p_before_item_id = any(v_ids)) then
    raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;

  foreach v_id in array v_ids loop
    if v_id = p_item_id then
      continue;
    end if;
    if p_before_item_id is not null and v_id = p_before_item_id then
      v_new_ids := array_append(v_new_ids, p_item_id);
      v_before_found := true;
    end if;
    v_new_ids := array_append(v_new_ids, v_id);
  end loop;

  if p_before_item_id is null then
    v_new_ids := array_append(v_new_ids, p_item_id);
  elsif not v_before_found then
    raise exception 'ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.playlist_items i
  set position = o.position
  from (
    select id, (ordinality - 1)::integer as position
    from unnest(v_new_ids) with ordinality as t(id, ordinality)
  ) o
  where i.id = o.id and i.playlist_id = p_playlist_id;

  update public.playlists p
  set revision = p.revision + 1, updated_at = now()
  where p.id = p_playlist_id
  returning * into v_playlist;

  return jsonb_build_object(
    'playlist', to_jsonb(v_playlist),
    'items', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.position)
      from public.playlist_items i
      where i.playlist_id = p_playlist_id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- History / discovery
-- ---------------------------------------------------------------------------

create or replace function public.popular_tracks(
  p_window text,
  p_limit integer default 50
) returns table (
  rank bigint,
  track_id text,
  track jsonb,
  play_count bigint,
  unique_listeners bigint,
  score double precision
)
language sql
stable
as $$
  with filtered as (
    select *
    from public.playback_events
    where track_json is not null
      and listened_at >= case p_window
        when '24h' then now() - interval '24 hours'
        when '7d' then now() - interval '7 days'
        when '30d' then now() - interval '30 days'
        else '-infinity'::timestamptz
      end
  ),
  aggregated as (
    select
      track_id,
      (array_agg(track_json order by listened_at desc))[1] as track,
      count(*)::bigint as play_count,
      count(distinct user_id)::bigint as unique_listeners,
      coalesce(sum(played_duration_ms), 0)::double precision as score
    from filtered
    group by track_id
    order by score desc, play_count desc
    limit greatest(1, least(p_limit, 100))
  )
  select
    (row_number() over (order by score desc, play_count desc))::bigint as rank,
    track_id,
    track,
    play_count,
    unique_listeners,
    score
  from aggregated;
$$;

create or replace function public.global_leaderboard(
  p_period text,
  p_limit integer default 20
) returns table (
  rank bigint,
  user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  played_duration_ms bigint,
  play_count bigint
)
language sql
stable
as $$
  with filtered as (
    select user_id, played_duration_ms
    from public.playback_events
    where listened_at >= case p_period
      when 'weekly' then now() - interval '7 days'
      when 'monthly' then now() - interval '30 days'
      else '-infinity'::timestamptz
    end
  ),
  aggregated as (
    select
      user_id,
      coalesce(sum(played_duration_ms), 0)::bigint as played_duration_ms,
      count(*)::bigint as play_count
    from filtered
    group by user_id
  )
  select
    (row_number() over (order by a.played_duration_ms desc))::bigint as rank,
    p.id as user_id,
    p.username,
    p.display_name,
    p.avatar_url,
    a.played_duration_ms,
    a.play_count
  from aggregated a
  join public.profiles p on p.id = a.user_id
  where p.participate_leaderboards
  order by a.played_duration_ms desc
  limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.artist_leaderboard(
  p_artist_id text,
  p_period text,
  p_limit integer default 10
) returns table (
  rank bigint,
  user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  played_duration_ms bigint,
  play_count bigint
)
language sql
stable
as $$
  with filtered as (
    select user_id, played_duration_ms
    from public.playback_events
    where listened_at >= case p_period
      when 'weekly' then now() - interval '7 days'
      when 'monthly' then now() - interval '30 days'
      else '-infinity'::timestamptz
    end
      and exists (
        select 1
        from jsonb_array_elements(
          coalesce(track_json -> 'artists', '[]'::jsonb)
        ) as artist
        where artist ->> 'id' = p_artist_id
      )
  ),
  aggregated as (
    select
      user_id,
      coalesce(sum(played_duration_ms), 0)::bigint as played_duration_ms,
      count(*)::bigint as play_count
    from filtered
    group by user_id
  )
  select
    (row_number() over (order by a.played_duration_ms desc))::bigint as rank,
    p.id as user_id,
    p.username,
    p.display_name,
    p.avatar_url,
    a.played_duration_ms,
    a.play_count
  from aggregated a
  join public.profiles p on p.id = a.user_id
  where p.participate_leaderboards
  order by a.played_duration_ms desc
  limit greatest(1, least(p_limit, 100));
$$;

-- ---------------------------------------------------------------------------
-- Lock the data down: only the service role (the Worker) may touch it.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.liked_tracks enable row level security;
alter table public.saved_collections enable row level security;
alter table public.user_preferences enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_items enable row level security;
alter table public.playback_events enable row level security;
alter table public.follows enable row level security;

grant usage on schema public to service_role;

grant select, insert, update, delete on
  public.profiles,
  public.sessions,
  public.liked_tracks,
  public.saved_collections,
  public.user_preferences,
  public.playlists,
  public.playlist_items,
  public.playback_events,
  public.follows
to service_role;

revoke all on
  public.profiles,
  public.sessions,
  public.liked_tracks,
  public.saved_collections,
  public.user_preferences,
  public.playlists,
  public.playlist_items,
  public.playback_events,
  public.follows
from anon, authenticated;

revoke all on function public.register_user(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.login_user(text, text)
  from public, anon, authenticated;
revoke all on function public.get_user_profile(text, uuid)
  from public, anon, authenticated;
revoke all on function public.search_users(text, integer)
  from public, anon, authenticated;
revoke all on function public.user_followers(text)
  from public, anon, authenticated;
revoke all on function public.user_following(text)
  from public, anon, authenticated;
revoke all on function public.add_playlist_items(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.remove_playlist_item(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.move_playlist_item(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.popular_tracks(text, integer)
  from public, anon, authenticated;
revoke all on function public.global_leaderboard(text, integer)
  from public, anon, authenticated;
revoke all on function public.artist_leaderboard(text, text, integer)
  from public, anon, authenticated;

grant execute on function public.register_user(text, text, text, text) to service_role;
grant execute on function public.login_user(text, text) to service_role;
grant execute on function public.get_user_profile(text, uuid) to service_role;
grant execute on function public.search_users(text, integer) to service_role;
grant execute on function public.user_followers(text) to service_role;
grant execute on function public.user_following(text) to service_role;
grant execute on function public.add_playlist_items(uuid, jsonb) to service_role;
grant execute on function public.remove_playlist_item(uuid, uuid) to service_role;
grant execute on function public.move_playlist_item(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.popular_tracks(text, integer) to service_role;
grant execute on function public.global_leaderboard(text, integer) to service_role;
grant execute on function public.artist_leaderboard(text, text, integer) to service_role;
