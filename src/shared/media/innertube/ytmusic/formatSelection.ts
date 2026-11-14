/**
 * Audio format selection — ported from InnerTubeX `FormatSelectors.kt`.
 *
 * Metrolist scores formats by codec rank, channel count, bitrate and sample
 * rate, and never lets a dubbed audio track outrank the original recording:
 * multi-language uploads expose one format per dub and a dub can win on
 * bitrate alone. `xtags` carries `acont=original|dubbed` and is consulted first.
 *
 * Quality tiers map onto the app's streaming tiers: `low` takes the smallest
 * MP4/AAC (cheapest to decode), `standard` prefers Opus/WebM, `high` takes the
 * objectively best format. A codec preference overrides the tier's container
 * bias (Safari cannot decode WebM/Opus at all).
 */

export interface YtAudioFormat {
  itag: number;
  /** Direct media URL (unciphered clients). */
  url?: string;
  /** `signatureCipher`/`cipher` payloads need the cipher service. */
  signatureCipher?: string;
  cipher?: string;
  mimeType: string;
  bitrate: number;
  averageBitrate?: number;
  contentLength?: number;
  audioQuality?: string;
  audioChannels?: number;
  audioSampleRate?: number;
  /** base64url protobuf map; `acont=original` marks the primary dub. */
  xtags?: string;
}

export type YtMusicQuality = "low" | "standard" | "high";

export interface YtFormatPreference {
  quality?: YtMusicQuality;
  preferredCodec?: "opus" | "aac";
}

export function isYtAudioFormat(format: YtAudioFormat): boolean {
  return Boolean(format) && String(format.mimeType || "").startsWith("audio/");
}

/** Formats must expose either a direct URL or a cipher to resolve. */
export function hasResolvableUrl(format: YtAudioFormat): boolean {
  return Boolean(format.url) || Boolean(format.signatureCipher) || Boolean(format.cipher);
}

function effectiveBitrate(format: YtAudioFormat): number {
  return format.bitrate || format.averageBitrate || 0;
}

function containerOf(format: YtAudioFormat): "mp4" | "webm" | "other" {
  const mime = String(format.mimeType || "").toLowerCase();
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  return "other";
}

/**
 * Multi-language uploads expose one format per dubbed track; a dub can outrank
 * the original by bitrate. Keep the original (or the default) track when the
 * response says which one it is.
 */
function originalAudioTrack(formats: YtAudioFormat[]): YtAudioFormat[] {
  const original = formats.filter((format) => audioContent(format) === "original");
  if (original.length > 0) return original;
  return formats;
}

const MAX_XTAGS_LENGTH = 1024;

/** Decodes `xtags` and reads the `acont` entry (a tiny protobuf map walk). */
function audioContent(format: YtAudioFormat): string | null {
  const encoded = typeof format.xtags === "string" ? format.xtags : null;
  if (!encoded || encoded.length > MAX_XTAGS_LENGTH) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(encoded);
  } catch {
    return null;
  }
  return findProtoMapValue(bytes, "acont");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readVarint(bytes: Uint8Array, index: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let cursor = index;
  while (cursor < bytes.length && shift < 35) {
    const byte = bytes[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  return null;
}

/**
 * Walks `repeated {1: key(string), 2: value(string)}` entries and returns the
 * value stored under `wantedKey`, or null when the payload is not shaped that
 * way. Unknown fields are skipped, malformed input fails soft.
 */
function findProtoMapValue(bytes: Uint8Array, wantedKey: string): string | null {
  let cursor = 0;
  while (cursor < bytes.length) {
    const entryTag = readVarint(bytes, cursor);
    if (!entryTag) return null;
    cursor = entryTag.next;
    const field = entryTag.value >>> 3;
    const wireType = entryTag.value & 0x7;
    if (field === 1 && wireType === 2) {
      const length = readVarint(bytes, cursor);
      if (!length || length.next + length.value > bytes.length) return null;
      const entry = bytes.subarray(length.next, length.next + length.value);
      cursor = length.next + length.value;
      const parsed = readProtoStringPair(entry);
      if (parsed && parsed.key === wantedKey) return parsed.value;
    } else {
      const skipped = skipField(bytes, cursor, wireType);
      if (!skipped) return null;
      cursor = skipped;
    }
  }
  return null;
}

function readProtoStringPair(bytes: Uint8Array): { key: string; value: string } | null {
  let cursor = 0;
  let key: string | null = null;
  let value: string | null = null;
  while (cursor < bytes.length) {
    const tag = readVarint(bytes, cursor);
    if (!tag) return null;
    cursor = tag.next;
    const field = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    if (wireType !== 2) {
      const skipped = skipField(bytes, cursor, wireType);
      if (!skipped) return null;
      cursor = skipped;
      continue;
    }
    const length = readVarint(bytes, cursor);
    if (!length || length.next + length.value > bytes.length) return null;
    const text = new TextDecoder().decode(bytes.subarray(length.next, length.next + length.value));
    cursor = length.next + length.value;
    if (field === 1) key = text;
    else if (field === 2) value = text;
  }
  return key !== null && value !== null ? { key, value } : null;
}

function skipField(bytes: Uint8Array, cursor: number, wireType: number): number | null {
  switch (wireType) {
    case 0: {
      const skipped = readVarint(bytes, cursor);
      return skipped ? skipped.next : null;
    }
    case 1:
      return cursor + 8 <= bytes.length ? cursor + 8 : null;
    case 2: {
      const length = readVarint(bytes, cursor);
      return length && length.next + length.value <= bytes.length ? length.next + length.value : null;
    }
    case 5:
      return cursor + 4 <= bytes.length ? cursor + 4 : null;
    default:
      return null;
  }
}

/** Score used by the `standard` tier: codec rank, channels, bitrate, sample rate. */
function audioFormatScore(format: YtAudioFormat): number {
  const container = containerOf(format);
  const codecRank = container === "webm" ? 100 : container === "mp4" ? 50 : 0;
  const channelBonus = format.audioChannels === 2 ? 50_000 : format.audioChannels === 1 ? 0 : 25_000;
  return (
    codecRank * 1_000_000 + channelBonus + effectiveBitrate(format) + Math.min(format.audioSampleRate ?? 0, 48_000) / 10
  );
}

function highAudioFormatComparator(a: YtAudioFormat, b: YtAudioFormat): number {
  const byBitrate = effectiveBitrate(a) - effectiveBitrate(b);
  if (byBitrate !== 0) return byBitrate;
  const byChannels = channelRank(a) - channelRank(b);
  if (byChannels !== 0) return byChannels;
  const bySampleRate = Math.min(a.audioSampleRate ?? 0, 48_000) - Math.min(b.audioSampleRate ?? 0, 48_000);
  if (bySampleRate !== 0) return bySampleRate;
  return containerRank(a) - containerRank(b);
}

function channelRank(format: YtAudioFormat): number {
  if (format.audioChannels === 2) return 2;
  if (format.audioChannels === undefined) return 1;
  return 0;
}

function containerRank(format: YtAudioFormat): number {
  const container = containerOf(format);
  return container === "webm" ? 2 : container === "mp4" ? 1 : 0;
}

/**
 * Picks the best audio format for the requested tier. Formats without a
 * resolvable URL are excluded unless the caller opts out (decipherable-only
 * inspection), and only the original audio track is considered.
 */
export function selectBestYtAudioFormat(
  formats: YtAudioFormat[],
  preference: YtFormatPreference = {},
  requireResolvable = true,
): YtAudioFormat | null {
  const valid = originalAudioTrack(
    (formats ?? []).filter(
      (format) => isYtAudioFormat(format) && (!requireResolvable || hasResolvableUrl(format)),
    ),
  );
  if (valid.length === 0) return null;

  const codec = preference.preferredCodec;
  const quality = preference.quality ?? "standard";

  // An explicit codec preference biases the container, mirroring the tiers.
  if (codec === "aac" || (quality === "low" && codec !== "opus")) {
    const mp4 = valid.filter((format) => containerOf(format) === "mp4");
    const pool = mp4.length > 0 ? mp4 : valid;
    if (quality === "low") return [...pool].sort((a, b) => effectiveBitrate(a) - effectiveBitrate(b))[0] ?? null;
    return [...pool].sort((a, b) => audioFormatScore(b) - audioFormatScore(a))[0] ?? null;
  }

  switch (quality) {
    case "low": {
      const mp4 = valid.filter((format) => containerOf(format) === "mp4");
      const pool = mp4.length > 0 ? mp4 : valid;
      return [...pool].sort((a, b) => effectiveBitrate(a) - effectiveBitrate(b))[0] ?? null;
    }
    case "high": {
      return [...valid].sort((a, b) => highAudioFormatComparator(b, a))[0] ?? null;
    }
    case "standard":
    default: {
      const webm = valid.filter((format) => containerOf(format) === "webm");
      const pool = webm.length > 0 ? webm : valid;
      return [...pool].sort((a, b) => audioFormatScore(b) - audioFormatScore(a))[0] ?? null;
    }
  }
}
