/** Minimal shape needed for identity scoring (accepts both UI tracks and API contracts). */
export interface MatchableTrack {
  id: string;
  title: string;
  artists: string | ReadonlyArray<{ name: string }>;
  durationMs: number;
  album?: { title?: string } | null;
}

/**
 * Recording identity matching.
 *
 * Used when a playback source returns a recording whose identifier differs from
 * the requested one. We must never silently substitute an unrelated song, a
 * cover, a live performance or a remix, so every candidate is scored against
 * the reference recording using title, artist, duration, album and explicit
 * version markers. Auto-fallback only happens above MIN_AUTO_MATCH_CONFIDENCE.
 */

const VERSION_MARKERS: Array<[RegExp, number]> = [
  [/\b(live|acoustic|unplugged|remix|rmx|cover|karaoke|instrumental|demo|session|edit|extended|deluxe|sped\s*up|slowed|nightcore|reprise)\b/i, 0],
];

export interface MatchScore {
  confidence: number;
  sameRecordingId: boolean;
  reasons: string[];
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, " ") // drop (feat. X) / [Remix] style parentheticals first pass
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleVersionTags(title: string): string[] {
  const tags: string[] = [];
  const lowered = title.toLowerCase();
  for (const [re] of VERSION_MARKERS) {
    const m = lowered.match(re);
    if (m) tags.push(m[1].toLowerCase());
  }
  const bracket = title.match(/[([]([^)\]]*)[)\]]/g);
  if (bracket) {
    for (const b of bracket) tags.push(b.replace(/[([]|[)\]]/g, "").toLowerCase().trim());
  }
  return tags.filter(Boolean);
}

export function artistTokens(artists: MatchableTrack["artists"]): string[] {
  const raw = typeof artists === "string" ? artists : (artists ?? []).map((a) => a.name).join(", ");
  return raw
    .toLowerCase()
    .split(/[,/&+]| feat\.? | ft\.? | with /i)
    .map((s) => s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Scores how confidently `candidate` is the same recording as `reference`.
 * Returns 0..1 plus human readable reasons for diagnostics / UI.
 */
export function scoreRecordingMatch(reference: MatchableTrack, candidate: MatchableTrack): MatchScore {
  const reasons: string[] = [];

  const sameRecordingId = candidate.id === reference.id;
  if (sameRecordingId) {
    return { confidence: 1, sameRecordingId: true, reasons: ["same recording id"] };
  }

  let score = 0;
  let max = 0;

  // Title similarity (0.35)
  max += 0.35;
  const rt = normalizeTitle(reference.title);
  const ct = normalizeTitle(candidate.title);
  if (rt && ct) {
    if (rt === ct) score += 0.35;
    else if (rt.includes(ct) || ct.includes(rt)) score += 0.22;
    else {
      const a = new Set(rt.split(" "));
      const b = new Set(ct.split(" "));
      const inter = [...a].filter((w) => b.has(w)).length;
      const union = new Set([...a, ...b]).size || 1;
      score += 0.35 * (inter / union);
    }
  }

  // Version markers must agree — a live/cover/remix is never a match.
  const refTags = new Set(titleVersionTags(reference.title));
  const candTags = new Set(titleVersionTags(candidate.title));
  const meaningfulRef = [...refTags].filter((t) => t.length > 2);
  const meaningfulCand = [...candTags].filter((t) => t.length > 2);
  const tagsConflict =
    (meaningfulRef.length > 0 || meaningfulCand.length > 0) &&
    !meaningfulRef.some((t) => meaningfulCand.includes(t));
  if (tagsConflict) {
    reasons.push(`version markers differ (${[...meaningfulRef].join("/") || "none"} vs ${[...meaningfulCand].join("/") || "none"})`);
    return { confidence: 0, sameRecordingId: false, reasons };
  }

  // Artists (0.3)
  max += 0.3;
  const ra = artistTokens(reference.artists);
  const ca = artistTokens(candidate.artists);
  if (ra.length && ca.length) {
    const shared = ra.some((x) => ca.includes(x));
    if (shared) score += 0.3;
    else reasons.push(`artists differ (${reference.artists} vs ${candidate.artists})`);
  }

  // Duration within tolerance (0.25)
  max += 0.25;
  const durDelta = Math.abs((reference.durationMs || 0) - (candidate.durationMs || 0));
  if (reference.durationMs > 0 && candidate.durationMs > 0) {
    if (durDelta <= 2000) score += 0.25;
    else if (durDelta <= 8000) score += 0.14;
    else if (durDelta <= 20000) score += 0.05;
    else reasons.push(`duration differs by ${Math.round(durDelta / 1000)}s`);
  }

  // Album agreement is a weak bonus (0.1) — optional metadata.
  max += 0.1;
  if (reference.album?.title && candidate.album?.title) {
    if (normalizeTitle(reference.album.title) === normalizeTitle(candidate.album.title)) score += 0.1;
  }

  const confidence = max > 0 ? Math.min(1, score / max) : 0;
  if (confidence < 0.8) reasons.push("low overall similarity");

  return { confidence, sameRecordingId: false, reasons };
}
