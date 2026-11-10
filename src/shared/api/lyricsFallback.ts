import type { LyricsCandidate, LyricsStreamEvent } from "../contracts/lyrics";

/**
 * Direct lyrics fallback for builds whose backend does not serve lyrics.
 *
 * The self-hosted `api-worker` answers `/v1/tracks/:id/lyrics` with
 * `404 CLIENT_ONLY` (catalog, playback and lyrics are resolved on the device by
 * design). Desktop and Android used to get them from the hosted API; the
 * website port has no such upstream, so lyrics come straight from LRCLIB, which
 * is a public, CORS-enabled, key-less API.
 *
 * Only what the provider actually returns is claimed: synced lines when it has
 * them, plain text otherwise.
 */

interface LrclibRecord {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const LRCLIB_BASE = "https://lrclib.net/api";

function candidateFrom(
  record: LrclibRecord,
  slideId: string,
): LyricsCandidate | null {
  const synced = record.syncedLyrics?.trim();
  const plain = record.plainLyrics?.trim();
  const content = synced || plain;
  if (!content) return null;

  const lineSynced = Boolean(synced);
  return {
    provider: "lrclib",
    matchedTrack: {
      title: record.trackName,
      artists: record.artistName ? [record.artistName] : undefined,
      durationMs: record.duration ? Math.round(record.duration * 1000) : undefined,
    },
    lyrics: {
      format: lineSynced ? "lrc" : "plain",
      content,
    },
    contentKind: lineSynced ? "line_synced" : "plain",
    syncLevel: lineSynced ? "line_level" : "plain",
    // Deliberately modest: an unsynced fallback must not outrank a synced
    // provider if the backend ever serves one again.
    quality: {
      total: lineSynced ? 58 : 34,
      match: 16,
      content: lineSynced ? 26 : 18,
      sync: lineSynced ? 16 : 0,
      source: 4,
      reasons: [`lrclib:${slideId}`],
    },
  };
}

async function lookup(
  url: string,
  signal?: AbortSignal,
): Promise<LrclibRecord | null> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const body = (await res.json()) as LrclibRecord | LrclibRecord[];
  if (Array.isArray(body)) {
    // Search results: prefer a record that actually has lyrics, synced first.
    const withLyrics = body.filter((item) => item.syncedLyrics || item.plainLyrics);
    withLyrics.sort(
      (a, b) => Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)),
    );
    return withLyrics[0] ?? null;
  }
  return body ?? null;
}

export async function* streamLrclibLyrics(
  id: string,
  hint?: { title: string; artist: string; durationMs?: number },
  signal?: AbortSignal,
): AsyncGenerator<LyricsStreamEvent> {
  const title = hint?.title?.trim();
  const artist = hint?.artist?.trim();
  if (!title || !artist) return;

  let record: LrclibRecord | null = null;
  try {
    const exact = new URL(`${LRCLIB_BASE}/get`);
    exact.searchParams.set("track_name", title);
    exact.searchParams.set("artist_name", artist);
    if (hint?.durationMs && hint.durationMs > 0) {
      exact.searchParams.set("duration", String(Math.round(hint.durationMs / 1000)));
    }
    record = await lookup(exact.toString(), signal);
    if (!record?.syncedLyrics && !record?.plainLyrics) {
      const search = new URL(`${LRCLIB_BASE}/search`);
      search.searchParams.set("track_name", title);
      search.searchParams.set("artist_name", artist);
      record = await lookup(search.toString(), signal);
    }
  } catch {
    record = null;
  }

  const candidate = record ? candidateFrom(record, id) : null;
  if (!candidate) {
    yield { type: "provider", provider: "lrclib", status: "not_found" };
    yield { type: "done", cached: false, status: "not_found" };
    return;
  }

  yield {
    type: "provider",
    provider: "lrclib",
    status: "found",
    syncLevel: candidate.syncLevel,
    candidate,
    durationMs: candidate.matchedTrack?.durationMs,
  };
  yield { type: "done", cached: false };
}
