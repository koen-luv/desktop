const MAX_BODY_BYTES = 1_000_000;
const MAX_TRACKS = 500;

interface D1Result<T> {
  results: T[];
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}

interface D1Database {
  prepare(query: string): D1Statement;
}

interface Env {
  DB: D1Database;
  PRIMARY_API_URL?: string;
}

interface UserIdentity {
  id: string;
  username?: string | null;
  displayName?: string | null;
}

interface AuthContext {
  user: UserIdentity;
  token: string;
}

interface PlaylistRow {
  id: string;
  source_playlist_id: string;
  owner_id: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  role?: "owner" | "editor";
}

interface TrackRow {
  id: string;
  track_json: string;
  position: number;
  added_by: string;
  added_at: string;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: CORS_HEADERS });
}

async function readJson<T>(request: Request): Promise<T | null> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (!text || text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * The API this Worker delegates identity (and source-playlist) lookups to.
 *
 * It must be the same deployment the app signs into — this Worker holds no JWT
 * secret, it validates sessions by calling `/v1/me`. Pointing it at a different
 * API is what made every shared-playlist request answer 401.
 */
const DEFAULT_PRIMARY_API_URL = "https://liner-api.lucabatarcian.workers.dev";

async function authenticate(request: Request, env: Env): Promise<AuthContext | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const apiUrl = env.PRIMARY_API_URL ?? DEFAULT_PRIMARY_API_URL;
  const response = await fetch(`${apiUrl}/v1/me`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) return null;
  const user = (await response.json()) as UserIdentity;
  return typeof user.id === "string" ? { user, token } : null;
}

async function member(
  env: Env,
  playlistId: string,
  userId: string,
): Promise<"owner" | "editor" | null> {
  const row = await env.DB.prepare(
    "SELECT role FROM shared_playlist_members WHERE playlist_id = ? AND user_id = ?",
  )
    .bind(playlistId, userId)
    .first<{ role: "owner" | "editor" }>();
  return row?.role ?? null;
}

function apiUrl(env: Env, path: string): string {
  return `${env.PRIMARY_API_URL ?? DEFAULT_PRIMARY_API_URL}${path}`;
}

async function createSharedPlaylist(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson<{ sourcePlaylistId?: unknown }>(request);
  if (typeof body?.sourcePlaylistId !== "string" || !body.sourcePlaylistId.trim()) {
    return json({ error: "sourcePlaylistId is required" }, 400);
  }

  const upstream = await fetch(
    apiUrl(env, `/v1/me/playlists/${encodeURIComponent(body.sourcePlaylistId)}`),
    { headers: { authorization: `Bearer ${auth.token}`, accept: "application/json" } },
  );
  if (!upstream.ok) {
    return json(
      { error: upstream.status === 404 ? "Source playlist not found" : "Could not load source playlist" },
      upstream.status === 404 ? 404 : 502,
    );
  }
  const source = (await upstream.json()) as {
    playlist?: { title?: unknown; description?: unknown };
    items?: Array<{ track?: unknown; addedAt?: unknown }>;
  };
  if (
    !source.playlist ||
    typeof source.playlist.title !== "string" ||
    !Array.isArray(source.items) ||
    source.items.length > MAX_TRACKS ||
    source.items.some((item) => !item || typeof item.track !== "object" || item.track === null)
  ) {
    return json({ error: "Source playlist is invalid or too large to share" }, 422);
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const firstCover = source.items
    .map((item) => (item.track as { cover?: { url?: unknown } }).cover?.url)
    .find((url): url is string => typeof url === "string");
  await env.DB.prepare(
    `INSERT INTO shared_playlists
      (id, source_playlist_id, owner_id, title, description, cover_url, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(
      id,
      body.sourcePlaylistId,
      auth.user.id,
      source.playlist.title,
      typeof source.playlist.description === "string" ? source.playlist.description : null,
      firstCover ?? null,
      now,
      now,
    )
    .run();

  try {
    await env.DB.prepare(
      "INSERT INTO shared_playlist_members (playlist_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
    )
      .bind(id, auth.user.id, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO shared_playlist_user_profiles (user_id, username, displayName, avatarUrl)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username,
         displayName = excluded.displayName, avatarUrl = excluded.avatarUrl`,
    )
      .bind(
        auth.user.id,
        auth.user.username ?? null,
        auth.user.displayName ?? null,
        (auth.user as UserIdentity & { avatarUrl?: string }).avatarUrl ?? null,
      )
      .run();
    for (const [position, item] of source.items.entries()) {
      await env.DB.prepare(
        `INSERT INTO shared_playlist_tracks (id, playlist_id, track_json, position, added_by, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          id,
          JSON.stringify(item.track),
          position,
          auth.user.id,
          typeof item.addedAt === "string" ? item.addedAt : now,
        )
        .run();
    }
  } catch (error) {
    await env.DB.prepare("DELETE FROM shared_playlists WHERE id = ?").bind(id).run();
    throw error;
  }

  return json({ playlist: await loadPlaylist(env, id, auth.user.id) }, 201);
}

async function loadPlaylist(
  env: Env,
  id: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const playlist = await env.DB.prepare(
    `SELECT p.*, m.role FROM shared_playlists p
     JOIN shared_playlist_members m ON m.playlist_id = p.id
     WHERE p.id = ? AND m.user_id = ?`,
  )
    .bind(id, userId)
    .first<PlaylistRow>();
  if (!playlist) return null;
  const { results } = await env.DB.prepare(
    "SELECT id, track_json, position, added_by, added_at FROM shared_playlist_tracks WHERE playlist_id = ? ORDER BY position",
  )
    .bind(id)
    .all<TrackRow>();
  const { results: members } = await env.DB.prepare(
    `SELECT m.user_id AS id, m.role, m.added_at AS addedAt,
       u.username, u.displayName, u.avatarUrl
     FROM shared_playlist_members m
     LEFT JOIN shared_playlist_user_profiles u ON u.user_id = m.user_id
     WHERE m.playlist_id = ? ORDER BY m.added_at`,
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return {
    id: playlist.id,
    sourcePlaylistId: playlist.source_playlist_id,
    ownerId: playlist.owner_id,
    title: playlist.title,
    description: playlist.description,
    coverUrl: playlist.cover_url,
    createdAt: playlist.created_at,
    updatedAt: playlist.updated_at,
    revision: playlist.revision,
    role: playlist.role,
    members,
    items: results.map((row) => ({
      id: row.id,
      track: JSON.parse(row.track_json),
      position: row.position,
      addedBy: row.added_by,
      addedAt: row.added_at,
    })),
  };
}

async function listPlaylists(env: Env, userId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.source_playlist_id AS sourcePlaylistId, p.owner_id AS ownerId,
       p.title, p.description, p.cover_url AS coverUrl, p.created_at AS createdAt,
       p.updated_at AS updatedAt, p.revision, m.role,
       (SELECT COUNT(*) FROM shared_playlist_tracks t WHERE t.playlist_id = p.id) AS trackCount
     FROM shared_playlists p
     JOIN shared_playlist_members m ON m.playlist_id = p.id
     WHERE m.user_id = ? ORDER BY p.updated_at DESC`,
  )
    .bind(userId)
    .all<Record<string, unknown>>();
  return json({ items: results });
}

async function inviteMember(
  request: Request,
  env: Env,
  auth: AuthContext,
  playlistId: string,
): Promise<Response> {
  const role = await member(env, playlistId, auth.user.id);
  if (role !== "owner") return json({ error: "Only the playlist owner can invite collaborators" }, 403);
  const body = await readJson<{ userId?: unknown }>(request);
  if (typeof body?.userId !== "string" || !body.userId || body.userId === auth.user.id) {
    return json({ error: "A different userId is required" }, 400);
  }
  const profile = await fetch(apiUrl(env, `/v1/users/${encodeURIComponent(body.userId)}`), {
    headers: { authorization: `Bearer ${auth.token}`, accept: "application/json" },
  });
  if (!profile.ok) return json({ error: "User was not found" }, profile.status === 404 ? 404 : 502);
  const user = (await profile.json()) as UserIdentity;
  if (typeof user.id !== "string" || user.id !== body.userId) {
    return json({ error: "User identity could not be verified" }, 422);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO shared_playlist_members (playlist_id, user_id, role, added_at) VALUES (?, ?, 'editor', ?)",
  )
    .bind(playlistId, user.id, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO shared_playlist_user_profiles (user_id, username, displayName, avatarUrl)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username = excluded.username,
       displayName = excluded.displayName, avatarUrl = excluded.avatarUrl`,
  )
    .bind(user.id, user.username ?? null, user.displayName ?? null, (user as UserIdentity & { avatarUrl?: string }).avatarUrl ?? null)
    .run();
  await env.DB.prepare("UPDATE shared_playlists SET updated_at = ?, revision = revision + 1 WHERE id = ?")
    .bind(now, playlistId)
    .run();
  return json({ playlist: await loadPlaylist(env, playlistId, auth.user.id) });
}

async function removeMember(
  env: Env,
  auth: AuthContext,
  playlistId: string,
  userId: string,
): Promise<Response> {
  const role = await member(env, playlistId, auth.user.id);
  if (role !== "owner" && auth.user.id !== userId) {
    return json({ error: "Not allowed to remove this collaborator" }, 403);
  }
  if (userId === auth.user.id) return json({ error: "The owner cannot leave their playlist" }, 400);
  await env.DB.prepare("DELETE FROM shared_playlist_members WHERE playlist_id = ? AND user_id = ?")
    .bind(playlistId, userId)
    .run();
  await env.DB.prepare("UPDATE shared_playlists SET updated_at = ?, revision = revision + 1 WHERE id = ?")
    .bind(new Date().toISOString(), playlistId)
    .run();
  return empty(204);
}

async function addTrack(
  request: Request,
  env: Env,
  auth: AuthContext,
  playlistId: string,
): Promise<Response> {
  const role = await member(env, playlistId, auth.user.id);
  if (!role) return json({ error: "Playlist not found" }, 404);
  const body = await readJson<{ track?: unknown }>(request);
  if (!body || typeof body.track !== "object" || body.track === null) {
    return json({ error: "Track snapshot is required" }, 400);
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const position = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM shared_playlist_tracks WHERE playlist_id = ?",
  )
    .bind(playlistId)
    .first<{ nextPosition: number }>();
  await env.DB.prepare(
    "INSERT INTO shared_playlist_tracks (id, playlist_id, track_json, position, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, playlistId, JSON.stringify(body.track), position?.nextPosition ?? 0, auth.user.id, now)
    .run();
  await env.DB.prepare("UPDATE shared_playlists SET updated_at = ?, revision = revision + 1 WHERE id = ?")
    .bind(now, playlistId)
    .run();
  return json({ item: { id, track: body.track, position: position?.nextPosition ?? 0, addedBy: auth.user.id, addedAt: now } }, 201);
}

async function removeTrack(
  env: Env,
  auth: AuthContext,
  playlistId: string,
  itemId: string,
): Promise<Response> {
  if (!(await member(env, playlistId, auth.user.id))) return json({ error: "Playlist not found" }, 404);
  await env.DB.prepare("DELETE FROM shared_playlist_tracks WHERE playlist_id = ? AND id = ?")
    .bind(playlistId, itemId)
    .run();
  const { results } = await env.DB.prepare(
    "SELECT id FROM shared_playlist_tracks WHERE playlist_id = ? ORDER BY position",
  )
    .bind(playlistId)
    .all<{ id: string }>();
  for (const [position, row] of results.entries()) {
    await env.DB.prepare("UPDATE shared_playlist_tracks SET position = ? WHERE id = ?")
      .bind(position, row.id)
      .run();
  }
  await env.DB.prepare("UPDATE shared_playlists SET updated_at = ?, revision = revision + 1 WHERE id = ?")
    .bind(new Date().toISOString(), playlistId)
    .run();
  return empty(204);
}

async function reorderTrack(
  request: Request,
  env: Env,
  auth: AuthContext,
  playlistId: string,
  itemId: string,
): Promise<Response> {
  if (!(await member(env, playlistId, auth.user.id))) return json({ error: "Playlist not found" }, 404);
  const body = await readJson<{ beforeItemId?: unknown }>(request);
  if (!body || !(body.beforeItemId === null || typeof body.beforeItemId === "string")) {
    return json({ error: "beforeItemId is required" }, 400);
  }
  const { results } = await env.DB.prepare(
    "SELECT id FROM shared_playlist_tracks WHERE playlist_id = ? ORDER BY position",
  )
    .bind(playlistId)
    .all<{ id: string }>();
  const ids = results.map((row) => row.id);
  const from = ids.indexOf(itemId);
  const to = body.beforeItemId === null ? ids.length : ids.indexOf(body.beforeItemId);
  if (from < 0 || to < 0) return json({ error: "Track was not found" }, 404);
  const [moving] = ids.splice(from, 1);
  const insertAt = body.beforeItemId === null ? ids.length : ids.indexOf(body.beforeItemId);
  ids.splice(insertAt, 0, moving);
  for (const [position, id] of ids.entries()) {
    await env.DB.prepare("UPDATE shared_playlist_tracks SET position = ? WHERE playlist_id = ? AND id = ?")
      .bind(position, playlistId, id)
      .run();
  }
  await env.DB.prepare("UPDATE shared_playlists SET updated_at = ?, revision = revision + 1 WHERE id = ?")
    .bind(new Date().toISOString(), playlistId)
    .run();
  return empty(204);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return empty(204);
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });

    let auth: AuthContext | null;
    try {
      auth = await authenticate(request, env);
    } catch (error) {
      console.error("[shared-playlists] auth verification failed", error);
      return json({ error: "Could not verify Liner account" }, 502);
    }
    if (!auth) return json({ error: "Authentication required" }, 401);

    if (url.pathname === "/playlists" && request.method === "GET") {
      return listPlaylists(env, auth.user.id);
    }
    if (url.pathname === "/playlists" && request.method === "POST") {
      try {
        return await createSharedPlaylist(request, env, auth);
      } catch (error) {
        console.error("[shared-playlists] create failed", error);
        return json({ error: "Could not create shared playlist" }, 500);
      }
    }

    const match = url.pathname.match(
      /^\/playlists\/([0-9a-f-]{36})(?:\/(collaborators(?:\/([a-zA-Z0-9_-]+))?|tracks(?:\/([0-9a-f-]{36})(?:\/move)?)))?$/,
    );
    if (!match) return json({ error: "Not found" }, 404);
    const [, playlistId, section, memberId, itemId] = match;

    if (!section && request.method === "GET") {
      if (!(await member(env, playlistId, auth.user.id))) return json({ error: "Playlist not found" }, 404);
      const playlist = await loadPlaylist(env, playlistId, auth.user.id);
      return playlist ? json({ playlist }) : json({ error: "Playlist not found" }, 404);
    }
    if (section === "collaborators" && request.method === "POST") {
      return inviteMember(request, env, auth, playlistId);
    }
    if (section?.startsWith("collaborators/") && request.method === "DELETE" && memberId) {
      return removeMember(env, auth, playlistId, memberId);
    }
    if (section === "tracks" && request.method === "POST") {
      return addTrack(request, env, auth, playlistId);
    }
    if (section === "tracks" && request.method === "DELETE" && itemId) {
      return removeTrack(env, auth, playlistId, itemId);
    }
    if (section === "tracks" && request.method === "PATCH" && itemId && url.pathname.endsWith("/move")) {
      return reorderTrack(request, env, auth, playlistId, itemId);
    }
    if (!section && request.method === "DELETE") {
      if ((await member(env, playlistId, auth.user.id)) !== "owner") {
        return json({ error: "Only the owner can delete a shared playlist" }, 403);
      }
      await env.DB.prepare("DELETE FROM shared_playlists WHERE id = ?").bind(playlistId).run();
      return empty(204);
    }
    return json({ error: "Not found" }, 404);
  },
};
