// neritium:// deeplink parsing, shared by main process (no electron imports here
// so vitest can cover it). same strict allowlist as the link server: fixed
// entity types, opaque catalog tokens only.
export const DEEP_LINK_SCHEME = "neritium";

// Links minted before the rebrand (the share redirector, support emails) still
// use liner://, so we keep answering that scheme too and only advertise the new
// one. Both parse into the exact same targets.
export const LEGACY_DEEP_LINK_SCHEMES = ["liner"] as const;

export const DEEP_LINK_SCHEMES: readonly string[] = [
  DEEP_LINK_SCHEME,
  ...LEGACY_DEEP_LINK_SCHEMES,
];

const DEEP_LINK_IDS: Record<string, RegExp> = {
  // youtube channel ids, always UC + 22 base64url chars
  artist: /^UC[A-Za-z0-9_-]{22}$/,
  // innertube album browse ids, e.g. MPREb_xCxkOKReFZv
  album: /^MPRE[A-Za-z0-9_-]{4,64}$/,
  // catalog playlists (VLPL…/PL…) and user playlists (uuid / pl-…),
  // all just opaque tokens from the same safe charset
  playlist: /^[A-Za-z0-9_-]{8,64}$/,
  // youtube video ids are always 11 base64url chars
  track: /^[A-Za-z0-9_-]{11}$/,
  // one-time password reset links from the Neritium support email
  "reset-password": /^lrst_[A-Za-z0-9_-]{43}$/,
};

export interface DeeplinkTarget {
  type: "artist" | "album" | "playlist" | "track" | "reset-password";
  id: string;
}

function isDeeplinkProtocol(protocol: string): boolean {
  return DEEP_LINK_SCHEMES.includes(protocol.replace(/:$/, "").toLowerCase());
}

export function parseDeeplink(raw: string): DeeplinkTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isDeeplinkProtocol(url.protocol)) return null;
  const type = url.hostname.toLowerCase();
  const pattern = DEEP_LINK_IDS[type];
  if (!pattern) return null;
  // exactly one id param, extras rejected so ?id=a&id=b can't pick a winner
  const ids = url.searchParams.getAll("id");
  if (ids.length !== 1) return null;
  const id = ids[0]!;
  if (!pattern.test(id)) return null;
  return { type: type as DeeplinkTarget["type"], id };
}

export function findDeeplinkArg(argv: string[]): string | undefined {
  const prefixes = DEEP_LINK_SCHEMES.map((scheme) => `${scheme}://`);
  return argv.find((arg) => {
    const lower = arg.toLowerCase();
    return prefixes.some((prefix) => lower.startsWith(prefix));
  });
}
