import {
  HttpError,
  clampNumber,
  decodeOffset,
  emailField,
  empty,
  encodeOffset,
  failure,
  getRequestId,
  isUuid,
  json,
  numberField,
  optionalBooleanField,
  optionalStringField,
  preflight,
  readJson,
  requireEnv,
  stringField,
  usernameField,
  type Env,
} from "./http";
import {
  randomToken,
  sha256Hex,
  signAccessToken,
  verifyAccessToken,
  type AccessUser,
} from "./auth";
import { Supabase, SupabaseError } from "./supabase";

// ---------------------------------------------------------------------------
// Wire types (kept in sync with src/shared/contracts)
// ---------------------------------------------------------------------------

interface TrackArtist {
  id: string;
  name: string;
}

interface Cover {
  url: string;
  width: number;
  height: number;
  fallbackUrl?: string;
}

interface Track {
  id: string;
  title: string;
  artists: TrackArtist[];
  album?: { id: string; title: string };
  durationMs: number;
  cover?: Cover;
  explicit?: boolean;
}

interface PublicUser {
  id: string;
  email?: string;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  isPublic?: boolean;
  showActivity?: boolean;
  showHistory?: boolean;
  showLikedTracks?: boolean;
  participateLeaderboards?: boolean;
}

interface UserProfile extends PublicUser {
  followersCount: number;
  followingCount: number;
  isFollowing?: boolean;
  createdAt: string;
  privacy: {
    isPublic: boolean;
    showActivity: boolean;
    showHistory: boolean;
    showLikedTracks: boolean;
    participateLeaderboards: boolean;
  };
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  user: PublicUser;
}

interface UserPlaylist {
  id: string;
  title: string;
  description?: string;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
  ownerId?: string;
  owner?: {
    id: string;
    username?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
  };
}

interface UserPlaylistItem {
  id: string;
  track: Track;
  position: number;
  addedAt: string;
}

interface PlaybackContext {
  type: string;
  id?: string;
}

interface PlaybackHistoryItem {
  id: string;
  playbackSessionId: string;
  listeningSessionId: string;
  track: Track;
  playedDurationMs: number;
  completionRate: number;
  completed: boolean;
  skipped: boolean;
  loopCount: number;
  hasSeekBackward: boolean;
  context?: PlaybackContext;
  listenedAt: string;
}

interface DailyMix {
  id: string;
  title: string;
  description: string;
  clusterArtists: string[];
  cover?: Cover;
  trackCount: number;
  tracks: Track[];
}

// ---------------------------------------------------------------------------
// Database rows
// ---------------------------------------------------------------------------

interface ProfileRow {
  id: string;
  email: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  password_hash: string;
  is_public: boolean;
  show_activity: boolean;
  show_history: boolean;
  show_liked_tracks: boolean;
  participate_leaderboards: boolean;
  created_at: string;
  updated_at: string;
}

interface ProfileViewRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  show_activity: boolean;
  show_history: boolean;
  show_liked_tracks: boolean;
  participate_leaderboards: boolean;
  created_at: string;
  followers_count: number | string;
  following_count: number | string;
  is_following?: boolean;
}

interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface PlaylistRow {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  is_public: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  playlist_id: string;
  track_id: string;
  track_json: unknown;
  position: number;
  added_at: string;
}

interface LikedRow {
  user_id: string;
  track_id: string;
  track_json: unknown;
  liked_at: string;
}

interface SavedRow {
  user_id: string;
  kind: "albums" | "artists" | "playlists";
  collection_id: string;
  snapshot: unknown;
  saved_at: string;
}

interface PreferenceRow {
  user_id: string;
  preferences: Record<string, unknown>;
  updated_at: string;
}

interface EventRow {
  id: string;
  user_id: string;
  playback_session_id: string;
  listening_session_id: string;
  track_id: string;
  track_json: unknown;
  played_duration_ms: number | string;
  track_duration_ms: number | string | null;
  completion_rate: number | string;
  completed: boolean;
  skipped: boolean;
  loop_count: number | string;
  has_seek_backward: boolean;
  context: unknown;
  listened_at: string;
}

interface PopularRow {
  rank: number | string;
  track_id: string;
  track: unknown;
  play_count: number | string;
  unique_listeners: number | string;
  score: number | string;
}

interface LeaderRow {
  rank: number | string;
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  played_duration_ms: number | string;
  play_count: number | string;
}

interface MoveResult {
  playlist: PlaylistRow;
  items: ItemRow[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const COLLECTION_KINDS = new Set(["albums", "artists", "playlists"]);
const WINDOWS = new Set(["24h", "7d", "30d", "all"]);
const PERIODS = new Set(["weekly", "monthly", "all_time"]);

function database(env: Env): Supabase {
  return new Supabase(
    requireEnv(env.SUPABASE_URL, "SUPABASE_URL"),
    requireEnv(env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"),
  );
}

function pathParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "INVALID_INPUT", "The request path is invalid.");
  }
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function limitParam(url: URL, fallback: number, max: number): number {
  const parsed = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isFinite(parsed) ? clampNumber(parsed, 1, max) : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Track normalization
// ---------------------------------------------------------------------------

function normalizeCover(value: unknown): Cover | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url || url.length > 2048 || !/^https?:\/\//i.test(url)) return undefined;
  const width =
    typeof input.width === "number" && Number.isFinite(input.width)
      ? Math.max(1, Math.round(input.width))
      : 640;
  const height =
    typeof input.height === "number" && Number.isFinite(input.height)
      ? Math.max(1, Math.round(input.height))
      : width;
  const cover: Cover = { url, width, height };
  const fallback =
    typeof input.fallbackUrl === "string" ? input.fallbackUrl.trim() : "";
  if (fallback && fallback.length <= 2048 && /^https?:\/\//i.test(fallback)) {
    cover.fallbackUrl = fallback;
  }
  return cover;
}

function normalizeTrack(value: unknown): Track | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id.trim().slice(0, 200) : "";
  const title =
    typeof input.title === "string" ? input.title.trim().slice(0, 300) : "";
  if (!id || !title) return null;

  const artists: TrackArtist[] = [];
  if (Array.isArray(input.artists)) {
    for (const entry of input.artists) {
      if (!entry || typeof entry !== "object") continue;
      const artist = entry as Record<string, unknown>;
      const name =
        typeof artist.name === "string" ? artist.name.trim().slice(0, 200) : "";
      if (!name) continue;
      artists.push({
        id:
          typeof artist.id === "string" && artist.id
            ? artist.id.slice(0, 200)
            : "unknown",
        name,
      });
    }
  }
  if (artists.length === 0) {
    artists.push({ id: "unknown", name: "Unknown Artist" });
  }

  const track: Track = {
    id,
    title,
    artists,
    durationMs:
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.round(input.durationMs))
        : 0,
  };

  if (input.album && typeof input.album === "object") {
    const album = input.album as Record<string, unknown>;
    if (typeof album.id === "string" && typeof album.title === "string") {
      const albumTitle = album.title.trim().slice(0, 300);
      if (albumTitle) {
        track.album = { id: album.id.slice(0, 200), title: albumTitle };
      }
    }
  }
  const cover = normalizeCover(input.cover);
  if (cover) track.cover = cover;
  if (typeof input.explicit === "boolean") track.explicit = input.explicit;
  return track;
}

function fallbackTrack(id: string): Track {
  return {
    id,
    title: "Unknown track",
    artists: [{ id: "unknown", name: "Unknown Artist" }],
    durationMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function publicUser(row: ProfileRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    isPublic: row.is_public,
    showActivity: row.show_activity,
    showHistory: row.show_history,
    showLikedTracks: row.show_liked_tracks,
    participateLeaderboards: row.participate_leaderboards,
  };
}

function userProfile(row: ProfileViewRow): UserProfile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    isPublic: row.is_public,
    showActivity: row.show_activity,
    showHistory: row.show_history,
    showLikedTracks: row.show_liked_tracks,
    participateLeaderboards: row.participate_leaderboards,
    followersCount: Number(row.followers_count ?? 0),
    followingCount: Number(row.following_count ?? 0),
    isFollowing: Boolean(row.is_following),
    createdAt: row.created_at,
    privacy: {
      isPublic: row.is_public,
      showActivity: row.show_activity,
      showHistory: row.show_history,
      showLikedTracks: row.show_liked_tracks,
      participateLeaderboards: row.participate_leaderboards,
    },
  };
}

function userPlaylist(row: PlaylistRow, owner?: ProfileRow | null): UserPlaylist {
  const playlist: UserPlaylist = {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    isPublic: row.is_public,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    ownerId: row.owner_id,
  };
  if (owner) {
    playlist.owner = {
      id: owner.id,
      username: owner.username,
      displayName: owner.display_name,
      avatarUrl: owner.avatar_url,
    };
  }
  return playlist;
}

function playlistItem(row: ItemRow): UserPlaylistItem {
  return {
    id: row.id,
    track: normalizeTrack(row.track_json) ?? fallbackTrack(row.track_id),
    position: row.position,
    addedAt: row.added_at,
  };
}

function historyItem(row: EventRow): PlaybackHistoryItem {
  return {
    id: row.id,
    playbackSessionId: row.playback_session_id,
    listeningSessionId: row.listening_session_id,
    track: normalizeTrack(row.track_json) ?? fallbackTrack(row.track_id),
    playedDurationMs: Number(row.played_duration_ms ?? 0),
    completionRate: Number(row.completion_rate ?? 0),
    completed: Boolean(row.completed),
    skipped: Boolean(row.skipped),
    loopCount: Number(row.loop_count ?? 0),
    hasSeekBackward: Boolean(row.has_seek_backward),
    context:
      row.context && typeof row.context === "object"
        ? (row.context as PlaybackContext)
        : undefined,
    listenedAt: row.listened_at,
  };
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function currentUser(request: Request, env: Env): Promise<AccessUser> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    throw new HttpError(401, "UNAUTHORIZED", "Sign in to continue.");
  }
  const token = header.slice(7).trim();
  const user = token ? await verifyAccessToken(env, token) : null;
  if (!user) {
    throw new HttpError(401, "UNAUTHORIZED", "Your session expired. Sign in again.");
  }
  return user;
}

async function optionalUser(
  request: Request,
  env: Env,
): Promise<AccessUser | null> {
  try {
    return await currentUser(request, env);
  } catch {
    return null;
  }
}

async function loadProfile(env: Env, id: string): Promise<ProfileRow> {
  const row = await database(env).first<ProfileRow>(
    "profiles",
    `id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  if (!row) {
    throw new HttpError(401, "UNAUTHORIZED", "That account no longer exists.");
  }
  return row;
}

async function resolveProfile(env: Env, key: string): Promise<ProfileRow> {
  const clean = pathParam(key).trim();
  const filter = isUuid(clean)
    ? `id=eq.${clean}`
    : `username=eq.${encodeURIComponent(clean.toLowerCase())}`;
  const row = await database(env).first<ProfileRow>(
    "profiles",
    `${filter}&select=*&limit=1`,
  );
  if (!row) {
    throw new HttpError(404, "USER_NOT_FOUND", "That user was not found.");
  }
  return row;
}

function refreshExpiry(env: Env): string {
  const days = clampNumber(Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30), 1, 365);
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function tokensFor(
  env: Env,
  profile: ProfileRow,
  refreshToken: string,
): Promise<AuthTokens> {
  const access = await signAccessToken(env, {
    id: profile.id,
    username: profile.username,
  });
  return {
    accessToken: access.token,
    refreshToken,
    accessTokenExpiresAt: access.expiresAt,
    user: publicUser(profile),
  };
}

async function issueSession(
  env: Env,
  db: Supabase,
  profile: ProfileRow,
): Promise<AuthTokens> {
  const refreshToken = randomToken(48);
  const hash = await sha256Hex(refreshToken);
  await db.insert(
    "sessions",
    [
      {
        id: crypto.randomUUID(),
        user_id: profile.id,
        refresh_token_hash: hash,
        expires_at: refreshExpiry(env),
      },
    ],
    { returning: false },
  );
  return tokensFor(env, profile, refreshToken);
}

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

type TurnstileMode = "off" | "optional" | "required";

function turnstileMode(env: Env): TurnstileMode {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY) return "off";
  const requested = (env.TURNSTILE_MODE ?? "off").toLowerCase();
  return requested === "required" || requested === "optional" ? requested : "off";
}

async function verifyTurnstile(
  request: Request,
  env: Env,
  token: string | undefined,
  action: "login" | "register",
): Promise<void> {
  const mode = turnstileMode(env);
  if (mode === "off") return;
  if (!token) {
    if (mode === "optional") return;
    throw new HttpError(
      403,
      "TURNSTILE_REQUIRED",
      "Complete the human check to continue.",
    );
  }

  const form = new URLSearchParams();
  form.set("secret", env.TURNSTILE_SECRET ?? "");
  form.set("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.set("remoteip", ip);

  let result: {
    success?: boolean;
    action?: string;
    "error-codes"?: string[];
  };
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
    );
    if (!response.ok) throw new Error(`siteverify responded ${response.status}`);
    result = (await response.json()) as typeof result;
  } catch (error) {
    console.error(
      "[liner-api] turnstile siteverify failed",
      error instanceof Error ? error.message : String(error),
    );
    throw new HttpError(
      503,
      "TURNSTILE_UNAVAILABLE",
      "The human check is temporarily unavailable. Try again.",
    );
  }

  if (!result.success) {
    console.warn("[liner-api] turnstile rejected", result["error-codes"]);
    throw new HttpError(
      403,
      "TURNSTILE_FAILED",
      "The human check did not pass. Try again.",
    );
  }
  if (result.action && result.action !== action) {
    throw new HttpError(
      403,
      "TURNSTILE_FAILED",
      "The human check was issued for a different action.",
    );
  }
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

async function handleChallenge(request: Request, env: Env): Promise<Response> {
  const mode = turnstileMode(env);
  return json(
    {
      mode: "off",
      algorithm: "argon2id-v1",
      token: randomToken(18),
      salt: randomToken(16),
      difficulty: 0,
      memoryKiB: 0,
      iterations: 0,
      parallelism: 0,
      hashLength: 32,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      turnstile: {
        mode,
        ...(mode === "off" ? {} : { siteKey: env.TURNSTILE_SITE_KEY }),
        edge: false,
      },
    },
    request,
    env,
  );
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const email = emailField(body.email);
  const password = stringField(body.password, "password", 1, 200, false);
  const token =
    typeof body.turnstile === "string" ? body.turnstile.slice(0, 4096) : undefined;
  await verifyTurnstile(request, env, token, "login");

  const db = database(env);
  const rows = await db.rpc<ProfileRow[]>("login_user", {
    p_email: email,
    p_password: password,
  });
  const profile = rows[0];
  if (!profile) {
    throw new HttpError(
      401,
      "INVALID_CREDENTIALS",
      "Email or password is incorrect.",
    );
  }
  return json(await issueSession(env, db, profile), request, env);
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const email = emailField(body.email);
  const password = stringField(body.password, "password", 8, 200, false);
  const username = usernameField(body.username);
  const displayName = stringField(body.displayName, "displayName", 1, 80);
  const token =
    typeof body.turnstile === "string" ? body.turnstile.slice(0, 4096) : undefined;
  await verifyTurnstile(request, env, token, "register");

  const db = database(env);
  const rows = await db.rpc<ProfileRow[]>("register_user", {
    p_email: email,
    p_password: password,
    p_username: username,
    p_display_name: displayName,
  });
  const profile = rows[0];
  if (!profile) {
    throw new HttpError(500, "INTERNAL_ERROR", "The account could not be created.");
  }
  return json(await issueSession(env, db, profile), request, env, 201);
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const refreshToken = stringField(body.refreshToken, "refreshToken", 20, 500, false);
  const hash = await sha256Hex(refreshToken);
  const db = database(env);

  const session = await db.first<SessionRow>(
    "sessions",
    `refresh_token_hash=eq.${encodeURIComponent(hash)}&select=*&limit=1`,
  );
  if (
    !session ||
    session.revoked_at ||
    Date.parse(session.expires_at) <= Date.now()
  ) {
    throw new HttpError(
      401,
      "INVALID_REFRESH_TOKEN",
      "The session expired. Sign in again.",
    );
  }

  const profile = await db.first<ProfileRow>(
    "profiles",
    `id=eq.${session.user_id}&select=*&limit=1`,
  );
  if (!profile) {
    throw new HttpError(401, "INVALID_REFRESH_TOKEN", "That account no longer exists.");
  }

  const nextToken = randomToken(48);
  const nextHash = await sha256Hex(nextToken);
  const rotated = await db.update<SessionRow>(
    "sessions",
    `id=eq.${session.id}&refresh_token_hash=eq.${encodeURIComponent(hash)}`,
    {
      refresh_token_hash: nextHash,
      expires_at: refreshExpiry(env),
    },
  );
  if (rotated.length === 0) {
    throw new HttpError(
      401,
      "INVALID_REFRESH_TOKEN",
      "The session expired. Sign in again.",
    );
  }
  return json(await tokensFor(env, profile, nextToken), request, env);
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const user = await optionalUser(request, env);
  const body = await readJson<Record<string, unknown>>(request);
  const refreshToken =
    typeof body.refreshToken === "string" ? body.refreshToken.slice(0, 500) : "";
  if (!refreshToken) return empty(request, env);

  const hash = await sha256Hex(refreshToken);
  const filter = `refresh_token_hash=eq.${encodeURIComponent(hash)}${
    user ? `&user_id=eq.${user.id}` : ""
  }`;
  await database(env).update<SessionRow>("sessions", filter, {
    revoked_at: nowIso(),
  });
  return empty(request, env);
}

// ---------------------------------------------------------------------------
// Profile routes
// ---------------------------------------------------------------------------

async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  return json(publicUser(await loadProfile(env, user.id)), request, env);
}

async function handleUpdateProfile(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const body = await readJson<Record<string, unknown>>(request);
  const patch: Record<string, unknown> = {};

  if (body.username !== undefined) patch.username = usernameField(body.username);
  if (body.displayName !== undefined) {
    const displayName = optionalStringField(body.displayName, "displayName", 80);
    patch.display_name = displayName?.trim() || null;
  }
  if (body.avatarUrl !== undefined) {
    const avatarUrl = optionalStringField(body.avatarUrl, "avatarUrl", 2048);
    if (
      avatarUrl &&
      !/^https?:\/\//i.test(avatarUrl) &&
      !avatarUrl.startsWith("data:image/")
    ) {
      throw new HttpError(400, "INVALID_INPUT", "avatarUrl must be an http(s) URL.");
    }
    patch.avatar_url = avatarUrl || null;
  }
  if (body.bio !== undefined) {
    const bio = optionalStringField(body.bio, "bio", 500);
    patch.bio = bio?.trim() || null;
  }
  for (const [field, column] of [
    ["isPublic", "is_public"],
    ["showActivity", "show_activity"],
    ["showHistory", "show_history"],
    ["showLikedTracks", "show_liked_tracks"],
    ["participateLeaderboards", "participate_leaderboards"],
  ] as const) {
    const value = optionalBooleanField(body[field], field);
    if (value !== undefined) patch[column] = value;
  }

  const db = database(env);
  if (Object.keys(patch).length === 0) {
    return json(publicUser(await loadProfile(env, user.id)), request, env);
  }
  patch.updated_at = nowIso();
  const rows = await db.update<ProfileRow>(
    "profiles",
    `id=eq.${user.id}`,
    patch,
  );
  if (!rows[0]) {
    throw new HttpError(404, "USER_NOT_FOUND", "That user was not found.");
  }
  return json(publicUser(rows[0]), request, env);
}

const PREFERENCES_MAX_BYTES = 64 * 1024;

async function handleGetPreferences(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const row = await database(env).first<PreferenceRow>(
    "user_preferences",
    `user_id=eq.${user.id}&select=*`,
  );
  return json(
    {
      preferences: row?.preferences ?? {},
      updatedAt: row?.updated_at ?? null,
    },
    request,
    env,
  );
}

async function handleUpdatePreferences(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const body = await readJson<Record<string, unknown>>(request);
  const preferences = body.preferences;
  if (
    !preferences ||
    typeof preferences !== "object" ||
    Array.isArray(preferences)
  ) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      "preferences must be a JSON object.",
    );
  }

  const serialized = JSON.stringify(preferences);
  if (new TextEncoder().encode(serialized).length > PREFERENCES_MAX_BYTES) {
    throw new HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      "The preferences payload is too large.",
    );
  }

  const updatedAt = nowIso();
  await database(env).upsert<PreferenceRow>(
    "user_preferences",
    [{ user_id: user.id, preferences, updated_at: updatedAt }],
    "user_id",
  );
  return json({ updatedAt }, request, env);
}

async function handleSearchUsers(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "")
    .replace(/[\\%_]/g, "")
    .trim()
    .slice(0, 50);
  if (query.length < 2) return json([], request, env);
  const rows = await database(env).rpc<ProfileViewRow[]>("search_users", {
    p_q: query,
    p_limit: 20,
  });
  return json(rows.map(userProfile), request, env);
}

async function handleUserProfile(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const viewer = await optionalUser(request, env);
  const rows = await database(env).rpc<ProfileViewRow[]>("get_user_profile", {
    p_key: pathParam(key),
    p_viewer_id: viewer?.id ?? null,
  });
  if (!rows[0]) {
    throw new HttpError(404, "USER_NOT_FOUND", "That user was not found.");
  }
  return json(userProfile(rows[0]), request, env);
}

async function handleFollow(
  request: Request,
  env: Env,
  key: string,
  method: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const target = await resolveProfile(env, key);
  if (target.id === user.id) {
    throw new HttpError(400, "INVALID_INPUT", "You cannot follow yourself.");
  }
  const db = database(env);
  if (method === "POST") {
    await db.insert(
      "follows",
      [{ follower_id: user.id, following_id: target.id }],
      {
        onConflict: "follower_id,following_id",
        ignoreDuplicates: true,
      },
    );
  } else {
    await db.delete(
      "follows",
      `follower_id=eq.${user.id}&following_id=eq.${target.id}`,
    );
  }
  return empty(request, env);
}

async function handleFollowList(
  request: Request,
  env: Env,
  key: string,
  followers: boolean,
): Promise<Response> {
  await resolveProfile(env, key);
  const rows = await database(env).rpc<ProfileViewRow[]>(
    followers ? "user_followers" : "user_following",
    { p_key: pathParam(key) },
  );
  return json(rows.map(userProfile), request, env);
}

async function handleUserPlaylists(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const target = await resolveProfile(env, key);
  const viewer = await optionalUser(request, env);
  const includePrivate = viewer?.id === target.id;
  const rows = await database(env).select<PlaylistRow>(
    "playlists",
    `owner_id=eq.${target.id}&select=*&order=updated_at.desc${
      includePrivate ? "" : "&is_public=eq.true"
    }`,
  );
  return json(
    { items: rows.map((row) => userPlaylist(row, target)) },
    request,
    env,
  );
}

async function handleUserHistory(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const target = await resolveProfile(env, key);
  const viewer = await optionalUser(request, env);
  if (viewer?.id !== target.id && !target.show_history) {
    return json({ items: [], nextCursor: null }, request, env);
  }
  const url = new URL(request.url);
  const limit = limitParam(url, 30, 100);
  const offset = decodeOffset(url.searchParams.get("cursor"));
  const rows = await database(env).select<EventRow>(
    "playback_events",
    `user_id=eq.${target.id}&select=*&order=listened_at.desc&limit=${limit}&offset=${offset}`,
  );
  return json(
    {
      items: rows.map(historyItem),
      nextCursor: rows.length === limit ? encodeOffset(offset + limit) : null,
    },
    request,
    env,
  );
}

// ---------------------------------------------------------------------------
// Library routes
// ---------------------------------------------------------------------------

async function handleLikedTracks(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const url = new URL(request.url);
  const limit = limitParam(url, 100, 200);
  const offset = decodeOffset(url.searchParams.get("cursor"));
  const rows = await database(env).select<LikedRow>(
    "liked_tracks",
    `user_id=eq.${user.id}&select=*&order=liked_at.desc,track_id.asc&limit=${limit}&offset=${offset}`,
  );
  return json(
    {
      items: rows.map((row) => ({
        track: normalizeTrack(row.track_json) ?? fallbackTrack(row.track_id),
        likedAt: row.liked_at,
      })),
      nextCursor: rows.length === limit ? encodeOffset(offset + limit) : null,
    },
    request,
    env,
  );
}

async function handleLikeTrack(
  request: Request,
  env: Env,
  trackId: string,
  method: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);
  const id = pathParam(trackId).trim().slice(0, 200);
  if (!id) throw new HttpError(400, "INVALID_INPUT", "A track id is required.");

  if (method === "DELETE") {
    await db.delete(
      "liked_tracks",
      `user_id=eq.${user.id}&track_id=eq.${encodeURIComponent(id)}`,
    );
    return empty(request, env);
  }

  const body = await readJson<Record<string, unknown>>(request);
  const track = await resolveTrackSnapshot(db, user.id, id, body);
  if (!track) {
    throw new HttpError(
      400,
      "TRACK_SNAPSHOT_REQUIRED",
      "The app could not resolve that track. Play it once, then try again.",
    );
  }
  await db.upsert(
    "liked_tracks",
    [
      {
        user_id: user.id,
        track_id: id,
        track_json: track,
        liked_at: nowIso(),
      },
    ],
    "user_id,track_id",
  );
  return empty(request, env);
}

async function handleSavedCollections(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const url = new URL(request.url);
  const kind = url.pathname.split("/").pop() ?? "";
  if (!COLLECTION_KINDS.has(kind)) {
    throw new HttpError(404, "NOT_FOUND", "Not found.");
  }
  const rows = await database(env).select<SavedRow>(
    "saved_collections",
    `user_id=eq.${user.id}&kind=eq.${kind}&select=*&order=saved_at.desc`,
  );
  const singular = kind === "albums" ? "album" : kind === "artists" ? "artist" : "playlist";
  return json(
    {
      items: rows.map((row) => ({
        [singular]: row.snapshot,
        savedAt: row.saved_at,
      })),
    },
    request,
    env,
  );
}

async function handleSaveCollection(
  request: Request,
  env: Env,
  kind: string,
  collectionId: string,
  method: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  if (!COLLECTION_KINDS.has(kind)) {
    throw new HttpError(404, "NOT_FOUND", "Not found.");
  }
  const db = database(env);
  const id = pathParam(collectionId).trim().slice(0, 300);
  if (!id) throw new HttpError(400, "INVALID_INPUT", "A collection id is required.");

  if (method === "DELETE") {
    await db.delete(
      "saved_collections",
      `user_id=eq.${user.id}&kind=eq.${kind}&collection_id=eq.${encodeURIComponent(id)}`,
    );
    return empty(request, env);
  }

  const body = await readJson<Record<string, unknown>>(request);
  if (!body.snapshot || typeof body.snapshot !== "object" || Array.isArray(body.snapshot)) {
    throw new HttpError(400, "INVALID_INPUT", "A snapshot is required.");
  }
  await db.upsert(
    "saved_collections",
    [
      {
        user_id: user.id,
        kind,
        collection_id: id,
        snapshot: body.snapshot,
        saved_at: nowIso(),
      },
    ],
    "user_id,kind,collection_id",
  );
  return empty(request, env);
}

async function resolveTrackSnapshot(
  db: Supabase,
  userId: string,
  trackId: string,
  body: Record<string, unknown>,
): Promise<Track | null> {
  const direct = normalizeTrack(body.track ?? body.trackSnapshot);
  if (direct) return { ...direct, id: trackId };

  const liked = await db.first<LikedRow>(
    "liked_tracks",
    `user_id=eq.${userId}&track_id=eq.${encodeURIComponent(trackId)}&select=*&limit=1`,
  );
  const fromLiked = normalizeTrack(liked?.track_json);
  if (fromLiked) return { ...fromLiked, id: trackId };

  // A track already in any playlist has a usable snapshot; metadata is public
  // catalog data, so this avoids forcing a catalog lookup on the client.
  const item = await db.first<ItemRow>(
    "playlist_items",
    `track_id=eq.${encodeURIComponent(trackId)}&select=*&limit=1`,
  );
  const fromItem = normalizeTrack(item?.track_json);
  if (fromItem) return { ...fromItem, id: trackId };

  const event = await db.first<EventRow>(
    "playback_events",
    `user_id=eq.${userId}&track_id=eq.${encodeURIComponent(trackId)}&select=*&order=listened_at.desc&limit=1`,
  );
  const fromEvent = normalizeTrack(event?.track_json);
  return fromEvent ? { ...fromEvent, id: trackId } : null;
}

// ---------------------------------------------------------------------------
// Playlist routes
// ---------------------------------------------------------------------------

async function loadOwnedPlaylist(
  db: Supabase,
  userId: string,
  playlistId: string,
): Promise<PlaylistRow> {
  if (!isUuid(playlistId)) {
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "That playlist was not found.");
  }
  const row = await db.first<PlaylistRow>(
    "playlists",
    `id=eq.${playlistId}&owner_id=eq.${userId}&select=*&limit=1`,
  );
  if (!row) {
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "That playlist was not found.");
  }
  return row;
}

async function handleListPlaylists(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const rows = await database(env).select<PlaylistRow>(
    "playlists",
    `owner_id=eq.${user.id}&select=*&order=updated_at.desc`,
  );
  return json({ items: rows.map((row) => userPlaylist(row)) }, request, env);
}

async function handleCreatePlaylist(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const body = await readJson<Record<string, unknown>>(request);
  const title = stringField(body.title, "title", 1, 200);
  const description =
    optionalStringField(body.description, "description", 2000)?.trim() || null;
  const isPublic = optionalBooleanField(body.isPublic, "isPublic") ?? false;
  const now = nowIso();
  const rows = await database(env).insert<PlaylistRow>("playlists", [
    {
      id: crypto.randomUUID(),
      owner_id: user.id,
      title,
      description,
      is_public: isPublic,
      revision: 1,
      created_at: now,
      updated_at: now,
    },
  ]);
  if (!rows[0]) {
    throw new HttpError(500, "INTERNAL_ERROR", "The playlist could not be created.");
  }
  return json(userPlaylist(rows[0]), request, env, 201);
}

async function handleGetPlaylist(
  request: Request,
  env: Env,
  playlistId: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);
  const playlist = await loadOwnedPlaylist(db, user.id, pathParam(playlistId));
  const items = await db.select<ItemRow>(
    "playlist_items",
    `playlist_id=eq.${playlist.id}&select=*&order=position.asc`,
  );
  return json(
    { playlist: userPlaylist(playlist), items: items.map(playlistItem) },
    request,
    env,
  );
}

async function handleUpdatePlaylist(
  request: Request,
  env: Env,
  playlistId: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);
  const current = await loadOwnedPlaylist(db, user.id, pathParam(playlistId));
  const body = await readJson<Record<string, unknown>>(request);
  const patch: Record<string, unknown> = {};

  if (body.title !== undefined) patch.title = stringField(body.title, "title", 1, 200);
  if (body.description !== undefined) {
    const description = optionalStringField(body.description, "description", 2000);
    patch.description = description?.trim() || null;
  }
  const isPublic = optionalBooleanField(body.isPublic, "isPublic");
  if (isPublic !== undefined) patch.is_public = isPublic;

  if (Object.keys(patch).length === 0) {
    return json(userPlaylist(current), request, env);
  }
  patch.updated_at = nowIso();
  patch.revision = current.revision + 1;
  const rows = await db.update<PlaylistRow>(
    "playlists",
    `id=eq.${current.id}&owner_id=eq.${user.id}`,
    patch,
  );
  if (!rows[0]) {
    throw new HttpError(404, "PLAYLIST_NOT_FOUND", "That playlist was not found.");
  }
  return json(userPlaylist(rows[0]), request, env);
}

async function handleDeletePlaylist(
  request: Request,
  env: Env,
  playlistId: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);
  const playlist = await loadOwnedPlaylist(db, user.id, pathParam(playlistId));
  await db.delete(
    "playlists",
    `id=eq.${playlist.id}&owner_id=eq.${user.id}`,
  );
  return empty(request, env);
}

async function handleAddPlaylistTrack(
  request: Request,
  env: Env,
  playlistId: string,
  trackId: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);
  const playlist = await loadOwnedPlaylist(db, user.id, pathParam(playlistId));
  const id = pathParam(trackId).trim().slice(0, 200);
  if (!id) throw new HttpError(400, "INVALID_INPUT", "A track id is required.");

  const body = await readJson<Record<string, unknown>>(request);
  const track = await resolveTrackSnapshot(db, user.id, id, body);
  if (!track) {
    throw new HttpError(
      400,
      "TRACK_SNAPSHOT_REQUIRED",
      "The app could not resolve that track. Play it once, then try again.",
    );
  }
  const rows = await db.rpc<ItemRow[]>("add_playlist_items", {
    p_playlist_id: playlist.id,
    p_tracks: [track],
  });
  if (!rows[0]) {
    throw new HttpError(400, "INVALID_TRACKS", "That track could not be added.");
  }
  return json(playlistItem(rows[0]), request, env, 201);
}

async function handleAddPlaylistTracks(
  request: Request,
  env: Env,
  playlistId: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);
  const playlist = await loadOwnedPlaylist(db, user.id, pathParam(playlistId));
  const body = await readJson<Record<string, unknown>>(request);
  if (!Array.isArray(body.tracks)) {
    throw new HttpError(400, "INVALID_INPUT", "A tracks array is required.");
  }
  const requested = body.tracks.slice(0, 500);
  const tracks = requested
    .map((track) => normalizeTrack(track))
    .filter((track): track is Track => Boolean(track));
  if (tracks.length === 0) {
    return json(
      { items: [], added: 0, rejected: body.tracks.length },
      request,
      env,
    );
  }
  const rows = await db.rpc<ItemRow[]>("add_playlist_items", {
    p_playlist_id: playlist.id,
    p_tracks: tracks,
  });
  return json(
    {
      items: rows.map(playlistItem),
      added: rows.length,
      rejected: body.tracks.length - rows.length,
    },
    request,
    env,
  );
}

async function handleRemovePlaylistItem(
  request: Request,
  env: Env,
  playlistId: string,
  itemId: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);
  const playlist = await loadOwnedPlaylist(db, user.id, pathParam(playlistId));
  const id = pathParam(itemId);
  if (!isUuid(id)) {
    throw new HttpError(404, "ITEM_NOT_FOUND", "That playlist item was not found.");
  }
  await db.rpc<void>("remove_playlist_item", {
    p_playlist_id: playlist.id,
    p_item_id: id,
  });
  return empty(request, env);
}

async function handleMovePlaylistItem(
  request: Request,
  env: Env,
  playlistId: string,
  itemId: string,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);
  const playlist = await loadOwnedPlaylist(db, user.id, pathParam(playlistId));
  const id = pathParam(itemId);
  if (!isUuid(id)) {
    throw new HttpError(404, "ITEM_NOT_FOUND", "That playlist item was not found.");
  }
  const body = await readJson<Record<string, unknown>>(request);
  const revision = numberField(body.revision, "revision", 1, 1_000_000);
  let beforeItemId: string | null = null;
  if (body.beforeItemId !== null && body.beforeItemId !== undefined) {
    if (typeof body.beforeItemId !== "string" || !isUuid(body.beforeItemId)) {
      throw new HttpError(400, "INVALID_INPUT", "beforeItemId is invalid.");
    }
    beforeItemId = body.beforeItemId;
  }
  const result = await db.rpc<MoveResult>("move_playlist_item", {
    p_playlist_id: playlist.id,
    p_item_id: id,
    p_before_item_id: beforeItemId,
    p_revision: revision,
  });
  return json(
    {
      playlist: userPlaylist(result.playlist),
      items: (result.items ?? []).map(playlistItem),
    },
    request,
    env,
  );
}

// ---------------------------------------------------------------------------
// History / discovery
// ---------------------------------------------------------------------------

async function handleRecordPlayback(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const body = await readJson<Record<string, unknown>>(request);
  const playbackSessionId = stringField(
    body.playbackSessionId,
    "playbackSessionId",
    1,
    200,
  );
  const listeningSessionId = stringField(
    body.listeningSessionId,
    "listeningSessionId",
    1,
    200,
  );
  const trackId = stringField(body.trackId, "trackId", 1, 200);
  const track = normalizeTrack(body.trackSnapshot);
  const context =
    body.context && typeof body.context === "object" && !Array.isArray(body.context)
      ? body.context
      : null;
  await database(env).upsert(
    "playback_events",
    [
      {
        id: crypto.randomUUID(),
        user_id: user.id,
        playback_session_id: playbackSessionId,
        listening_session_id: listeningSessionId,
        track_id: trackId,
        track_json: track,
        played_duration_ms: numberField(body.playedDurationMs, "playedDurationMs", 0, 86_400_000),
        track_duration_ms:
          body.trackDurationMs === undefined || body.trackDurationMs === null
            ? null
            : numberField(body.trackDurationMs, "trackDurationMs", 0, 86_400_000),
        completion_rate: clampFloat(body.completionRate, 0, 0, 1),
        completed: optionalBooleanField(body.completed, "completed") ?? false,
        skipped: optionalBooleanField(body.skipped, "skipped") ?? false,
        loop_count: body.loopCount === undefined ? 0 : numberField(body.loopCount, "loopCount", 0, 1000),
        has_seek_backward:
          optionalBooleanField(body.hasSeekBackward, "hasSeekBackward") ?? false,
        context,
        listened_at: nowIso(),
      },
    ],
    "user_id,playback_session_id",
  );
  return empty(request, env);
}

async function handleHistory(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  const url = new URL(request.url);
  const limit = limitParam(url, 30, 100);
  const offset = decodeOffset(url.searchParams.get("cursor"));
  const rows = await database(env).select<EventRow>(
    "playback_events",
    `user_id=eq.${user.id}&select=*&order=listened_at.desc&limit=${limit}&offset=${offset}`,
  );
  return json(
    {
      items: rows.map(historyItem),
      nextCursor: rows.length === limit ? encodeOffset(offset + limit) : null,
    },
    request,
    env,
  );
}

async function likedIdsFor(
  db: Supabase,
  userId: string | null,
  trackIds: string[],
): Promise<Set<string>> {
  if (!userId || trackIds.length === 0) return new Set();
  const rows = await db.select<{ track_id: string }>(
    "liked_tracks",
    `user_id=eq.${userId}&track_id=in.(${trackIds
      .map((id) => encodeURIComponent(id))
      .join(",")})&select=track_id`,
  );
  return new Set(rows.map((row) => row.track_id));
}

async function handlePopular(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requested = url.searchParams.get("window") ?? "7d";
  const window = WINDOWS.has(requested) ? requested : "7d";
  const limit = limitParam(url, 50, 100);
  const viewer = await optionalUser(request, env);
  const db = database(env);
  const rows = await db.rpc<PopularRow[]>("popular_tracks", {
    p_window: window,
    p_limit: limit,
  });
  const items = rows.flatMap((row) => {
    const track = normalizeTrack(row.track);
    if (!track) return [];
    return [
      {
        rank: Number(row.rank),
        track,
        playCount: Number(row.play_count),
        uniqueListeners: Number(row.unique_listeners),
        score: Number(row.score),
        ...(viewer ? { viewer: { liked: false } } : {}),
      },
    ];
  });
  if (viewer) {
    const liked = await likedIdsFor(
      db,
      viewer.id,
      items.map((item) => item.track.id),
    );
    for (const item of items) {
      if (item.viewer) item.viewer.liked = liked.has(item.track.id);
    }
  }
  return json(
    { window, generatedAt: nowIso(), items },
    request,
    env,
  );
}

interface MixEntry {
  track: Track;
  plays: number;
  last: string;
}

function buildDailyMixes(entries: MixEntry[], source: "history" | "liked"): DailyMix[] {
  if (entries.length === 0) return [];
  const clusters = new Map<
    string,
    { name: string; tracks: MixEntry[]; plays: number; artists: Set<string> }
  >();

  for (const entry of entries) {
    const primary = entry.track.artists[0] ?? {
      id: "unknown",
      name: "Unknown Artist",
    };
    const key = primary.id || primary.name;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { name: primary.name, tracks: [], plays: 0, artists: new Set() };
      clusters.set(key, cluster);
    }
    cluster.tracks.push(entry);
    cluster.plays += entry.plays;
    for (const artist of entry.track.artists) cluster.artists.add(artist.name);
  }

  return [...clusters.values()]
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 3)
    .map((cluster, index) => {
      const tracks = cluster.tracks
        .sort((a, b) => b.plays - a.plays || b.last.localeCompare(a.last))
        .slice(0, 20)
        .map((entry) => entry.track);
      const artists = [...cluster.artists].filter(
        (name) => name && name !== "Unknown Artist",
      );
      return {
        id: `daily-${index + 1}`,
        title: cluster.name === "Unknown Artist" ? "Your Mix" : `${cluster.name} Mix`,
        description:
          source === "history"
            ? "Built from what you have been playing"
            : "Built from the songs you liked",
        clusterArtists: artists.slice(0, 4),
        cover: tracks[0]?.cover,
        trackCount: tracks.length,
        tracks,
      };
    })
    .filter((mix) => mix.tracks.length > 0);
}

async function handleDailyMixes(
  request: Request,
  env: Env,
): Promise<Response> {
  const user = await currentUser(request, env);
  const db = database(env);

  const events = await db.select<
    Pick<EventRow, "track_id" | "track_json" | "listened_at">
  >(
    "playback_events",
    `user_id=eq.${user.id}&select=track_id,track_json,listened_at&order=listened_at.desc&limit=300`,
  );

  const byTrack = new Map<string, MixEntry>();
  for (const event of events) {
    const track = normalizeTrack(event.track_json);
    if (!track) continue;
    const existing = byTrack.get(track.id);
    if (existing) {
      existing.plays += 1;
      if (event.listened_at > existing.last) {
        existing.last = event.listened_at;
        existing.track = track;
      }
    } else {
      byTrack.set(track.id, {
        track,
        plays: 1,
        last: event.listened_at,
      });
    }
  }

  let source: "history" | "liked" = "history";
  if (byTrack.size === 0) {
    source = "liked";
    const liked = await db.select<
      Pick<LikedRow, "track_id" | "track_json" | "liked_at">
    >(
      "liked_tracks",
      `user_id=eq.${user.id}&select=track_id,track_json,liked_at&order=liked_at.desc&limit=200`,
    );
    for (const row of liked) {
      const track = normalizeTrack(row.track_json);
      if (!track || byTrack.has(track.id)) continue;
      byTrack.set(track.id, { track, plays: 1, last: row.liked_at });
    }
  }

  return json(
    { items: buildDailyMixes([...byTrack.values()], source), generatedAt: nowIso() },
    request,
    env,
  );
}

function leaderboard(
  rows: LeaderRow[],
  type: "artist" | "global",
  targetId: string,
  period: string,
) {
  return {
    type,
    targetId,
    period,
    entries: rows.map((row) => ({
      rank: Number(row.rank),
      user: {
        id: row.user_id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      },
      playedDurationMs: Number(row.played_duration_ms),
      playCount: Number(row.play_count),
    })),
    updatedAt: nowIso(),
  };
}

function periodParam(url: URL, fallback: string): string {
  const requested = url.searchParams.get("period") ?? fallback;
  return PERIODS.has(requested) ? requested : fallback;
}

async function handleGlobalLeaderboard(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const period = periodParam(url, "weekly");
  const limit = limitParam(url, 20, 100);
  const rows = await database(env).rpc<LeaderRow[]>("global_leaderboard", {
    p_period: period,
    p_limit: limit,
  });
  return json(leaderboard(rows, "global", "global", period), request, env);
}

async function handleArtistLeaderboard(
  request: Request,
  env: Env,
  artistId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const period = periodParam(url, "monthly");
  const limit = limitParam(url, 10, 100);
  const id = pathParam(artistId).slice(0, 200);
  const rows = await database(env).rpc<LeaderRow[]>("artist_leaderboard", {
    p_artist_id: id,
    p_period: period,
    p_limit: limit,
  });
  return json(leaderboard(rows, "artist", id, period), request, env);
}

// ---------------------------------------------------------------------------
// Hosted Turnstile page (used by packaged desktop and some WebViews)
// ---------------------------------------------------------------------------

function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function handleVerifyPage(request: Request, env: Env, url: URL): Response {
  const action = url.searchParams.get("action");
  if (action !== "login" && action !== "register") {
    throw new HttpError(400, "INVALID_INPUT", "A valid check action is required.");
  }
  const requestedTheme = url.searchParams.get("theme");
  const theme = requestedTheme === "light" || requestedTheme === "dark" ? requestedTheme : "";
  const siteKey = env.TURNSTILE_SITE_KEY ?? "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Liner verification</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; background: transparent; }
  body { display: flex; align-items: center; justify-content: center; }
  #widget { width: 100%; max-width: 320px; display: flex; justify-content: center; }
</style>
</head>
<body>
<div id="widget"></div>
<script>
(() => {
  const action = ${jsString(action)};
  const sitekey = ${jsString(siteKey)};
  const requestedTheme = ${jsString(theme)};
  const post = (type, token) => {
    const message = { source: "liner-turnstile", action, type };
    if (token) message.token = token;
    const targets = [window.parent, window.opener];
    for (const target of targets) {
      if (target && target !== window) {
        try { target.postMessage(message, "*"); } catch (_) {}
      }
    }
  };
  if (!sitekey) { post("error"); return; }
  const loader = document.createElement("script");
  loader.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  loader.async = true;
  loader.onload = () => {
    if (!window.turnstile) { post("error"); return; }
    window.turnstile.render("#widget", {
      sitekey,
      action,
      theme: requestedTheme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
      size: "flexible",
      "refresh-expired": "auto",
      callback: (token) => post("token", token),
      "expired-callback": () => post("expired"),
      "error-callback": () => post("error")
    });
  };
  loader.onerror = () => post("error");
  document.head.appendChild(loader);
})();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; img-src https://challenges.cloudflare.com data:; connect-src https://challenges.cloudflare.com",
      "x-request-id": getRequestId(request),
    },
  });
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapSupabaseError(error: SupabaseError): HttpError {
  const text = `${error.message} ${error.details ?? ""}`;
  if (text.includes("EMAIL_ALREADY_USED") || text.includes("profiles_email_key")) {
    return new HttpError(
      409,
      "EMAIL_ALREADY_USED",
      "This email is already in use.",
    );
  }
  if (text.includes("USERNAME_TAKEN") || text.includes("profiles_username_key")) {
    return new HttpError(
      409,
      "USERNAME_TAKEN",
      "This username is already taken. Please choose another.",
    );
  }
  if (text.includes("REVISION_CONFLICT")) {
    return new HttpError(
      409,
      "REVISION_CONFLICT",
      "The playlist changed. Reload it and try again.",
    );
  }
  if (text.includes("ITEM_NOT_FOUND")) {
    return new HttpError(
      404,
      "ITEM_NOT_FOUND",
      "That playlist item no longer exists.",
    );
  }
  if (text.includes("PLAYLIST_NOT_FOUND")) {
    return new HttpError(
      404,
      "PLAYLIST_NOT_FOUND",
      "That playlist no longer exists.",
    );
  }
  if (text.includes("INVALID_TRACKS")) {
    return new HttpError(400, "INVALID_TRACKS", "No valid tracks were provided.");
  }
  if (error.code === "23505") {
    return new HttpError(
      409,
      "CONFLICT",
      "That value is already in use.",
    );
  }
  console.error(
    "[liner-api] supabase error",
    error.status,
    error.code ?? "",
    error.message,
  );
  return new HttpError(500, "INTERNAL_ERROR", "Something went wrong. Try again.");
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === "/health" && method === "GET") {
    return json({ ok: true, service: "liner-api" }, request, env);
  }
  if (path === "/v1/auth/verify" && method === "GET") {
    return handleVerifyPage(request, env, url);
  }
  if (path === "/v1/auth/challenge" && method === "POST") {
    return handleChallenge(request, env);
  }
  if (path === "/v1/auth/login" && method === "POST") {
    return handleLogin(request, env);
  }
  if (path === "/v1/auth/register" && method === "POST") {
    return handleRegister(request, env);
  }
  if (path === "/v1/auth/refresh" && method === "POST") {
    return handleRefresh(request, env);
  }
  if (path === "/v1/auth/logout" && method === "POST") {
    return handleLogout(request, env);
  }

  if (path === "/v1/me" && method === "GET") {
    return handleMe(request, env);
  }
  if (path === "/v1/me/preferences" && method === "GET") {
    return handleGetPreferences(request, env);
  }
  if (path === "/v1/me/preferences" && method === "PUT") {
    return handleUpdatePreferences(request, env);
  }
  if (path === "/v1/users/me" && method === "PATCH") {
    return handleUpdateProfile(request, env);
  }
  if (path === "/v1/users/search" && method === "GET") {
    return handleSearchUsers(request, env);
  }

  if (path === "/v1/me/playlists" && method === "GET") {
    return handleListPlaylists(request, env);
  }
  if (path === "/v1/me/playlists" && method === "POST") {
    return handleCreatePlaylist(request, env);
  }

  const playlistBase = path.match(/^\/v1\/me\/playlists\/([^/]+)$/);
  if (playlistBase) {
    const playlistId = playlistBase[1];
    if (method === "GET") return handleGetPlaylist(request, env, playlistId);
    if (method === "PATCH") return handleUpdatePlaylist(request, env, playlistId);
    if (method === "DELETE") return handleDeletePlaylist(request, env, playlistId);
  }

  const moveItem = path.match(
    /^\/v1\/me\/playlists\/([^/]+)\/items\/([^/]+)\/move$/,
  );
  if (moveItem && method === "POST") {
    return handleMovePlaylistItem(request, env, moveItem[1], moveItem[2]);
  }
  const removeItem = path.match(
    /^\/v1\/me\/playlists\/([^/]+)\/items\/([^/]+)$/,
  );
  if (removeItem && method === "DELETE") {
    return handleRemovePlaylistItem(request, env, removeItem[1], removeItem[2]);
  }
  const addTrack = path.match(
    /^\/v1\/me\/playlists\/([^/]+)\/tracks\/([^/]+)$/,
  );
  if (addTrack && method === "POST") {
    return handleAddPlaylistTrack(request, env, addTrack[1], addTrack[2]);
  }
  const addTracks = path.match(/^\/v1\/me\/playlists\/([^/]+)\/tracks$/);
  if (addTracks && method === "POST") {
    return handleAddPlaylistTracks(request, env, addTracks[1]);
  }

  if (path === "/v1/me/library/tracks" && method === "GET") {
    return handleLikedTracks(request, env);
  }
  const likedTrack = path.match(/^\/v1\/me\/library\/tracks\/([^/]+)$/);
  if (likedTrack && (method === "PUT" || method === "DELETE")) {
    return handleLikeTrack(request, env, likedTrack[1], method);
  }

  const collections = path.match(/^\/v1\/me\/library\/(albums|artists|playlists)$/);
  if (collections && method === "GET") {
    return handleSavedCollections(request, env);
  }
  const collectionItem = path.match(
    /^\/v1\/me\/library\/(albums|artists|playlists)\/([^/]+)$/,
  );
  if (collectionItem && (method === "PUT" || method === "DELETE")) {
    return handleSaveCollection(
      request,
      env,
      collectionItem[1],
      collectionItem[2],
      method,
    );
  }

  if (path === "/v1/me/playback/events" && method === "POST") {
    return handleRecordPlayback(request, env);
  }
  if (path === "/v1/me/history" && method === "GET") {
    return handleHistory(request, env);
  }
  if (path === "/v1/me/recommendations/daily-mixes" && method === "GET") {
    return handleDailyMixes(request, env);
  }
  if (path === "/v1/explore/popular" && method === "GET") {
    return handlePopular(request, env);
  }
  if (path === "/v1/leaderboards/global" && method === "GET") {
    return handleGlobalLeaderboard(request, env);
  }
  const artistLeaderboard = path.match(/^\/v1\/leaderboards\/artist\/([^/]+)$/);
  if (artistLeaderboard && method === "GET") {
    return handleArtistLeaderboard(request, env, artistLeaderboard[1]);
  }

  const follow = path.match(/^\/v1\/users\/([^/]+)\/follow$/);
  if (follow && (method === "POST" || method === "DELETE")) {
    return handleFollow(request, env, follow[1], method);
  }
  const followers = path.match(/^\/v1\/users\/([^/]+)\/(followers|following)$/);
  if (followers && method === "GET") {
    return handleFollowList(request, env, followers[1], followers[2] === "followers");
  }
  const userPlaylists = path.match(/^\/v1\/users\/([^/]+)\/playlists$/);
  if (userPlaylists && method === "GET") {
    return handleUserPlaylists(request, env, userPlaylists[1]);
  }
  const userHistory = path.match(/^\/v1\/users\/([^/]+)\/history$/);
  if (userHistory && method === "GET") {
    return handleUserHistory(request, env, userHistory[1]);
  }
  const userProfile = path.match(/^\/v1\/users\/([^/]+)$/);
  if (userProfile && method === "GET") {
    return handleUserProfile(request, env, userProfile[1]);
  }

  // The catalog, playback signing, lyrics and Discord cloud presence stay on
  // the devices / are out of scope for this backend. A 404 (not 5xx) lets the
  // client fall back without surfacing a server-error toast.
  if (
    path === "/v1/search" ||
    path.startsWith("/v1/tracks/") ||
    path.startsWith("/v1/albums/") ||
    path.startsWith("/v1/artists/") ||
    /^\/v1\/playlists\/[^/]+$/.test(path)
  ) {
    return json(
      {
        code: "CLIENT_ONLY",
        message: "This route is resolved on the device by the client catalog.",
      },
      request,
      env,
      404,
    );
  }
  if (path.startsWith("/v1/me/discord")) {
    return json(
      {
        code: "DISCORD_UNAVAILABLE",
        message: "Discord cloud presence is not enabled on this backend.",
      },
      request,
      env,
      404,
    );
  }
  if (path.startsWith("/v1/auth/password-reset/")) {
    return json(
      {
        code: "PASSWORD_RESET_UNAVAILABLE",
        message: "Password reset emails are not configured on this backend.",
      },
      request,
      env,
      404,
    );
  }

  return json({ code: "NOT_FOUND", message: "Not found." }, request, env, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const preflightResponse = preflight(request, env);
    if (preflightResponse) return preflightResponse;

    const started = Date.now();
    try {
      const response = await route(request, env);
      console.log(
        JSON.stringify({
          method: request.method,
          path: new URL(request.url).pathname,
          status: response.status,
          ms: Date.now() - started,
        }),
      );
      return response;
    } catch (error) {
      const mapped =
        error instanceof SupabaseError ? mapSupabaseError(error) : error;
      const response = failure(mapped, request, env);
      console.log(
        JSON.stringify({
          method: request.method,
          path: new URL(request.url).pathname,
          status: response.status,
          ms: Date.now() - started,
        }),
      );
      return response;
    }
  },
};
