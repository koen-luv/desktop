CREATE TABLE IF NOT EXISTS shared_playlists (
  id TEXT PRIMARY KEY,
  source_playlist_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  cover_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shared_playlist_members (
  playlist_id TEXT NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (playlist_id, user_id)
);

CREATE INDEX IF NOT EXISTS shared_playlist_members_user
  ON shared_playlist_members(user_id, added_at DESC);

CREATE TABLE IF NOT EXISTS shared_playlist_user_profiles (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  displayName TEXT,
  avatarUrl TEXT
);

CREATE TABLE IF NOT EXISTS shared_playlist_tracks (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES shared_playlists(id) ON DELETE CASCADE,
  track_json TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS shared_playlist_tracks_order
  ON shared_playlist_tracks(playlist_id, position);
