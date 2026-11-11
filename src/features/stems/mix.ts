/**
 * Stem mixer maths.
 *
 * Kept pure and separate from the audio plumbing so the mute/solo rules — the
 * part that is easy to get subtly wrong — can be tested without a browser.
 *
 * Rules: a soloed stem is heard, every other stem is silenced; no solo means
 * every unmuted stem is heard.
 */

export type StemName = "vocals" | "drums" | "bass" | "other";

export interface StemChannel {
  name: StemName;
  /** 0..1 from the fader. */
  level: number;
  muted: boolean;
  solo: boolean;
}

export function anySoloed(channels: readonly StemChannel[]): boolean {
  return channels.some((channel) => channel.solo);
}

/** Final linear gain for one channel, given the whole mixer state. */
export function effectiveGain(
  channel: StemChannel,
  channels: readonly StemChannel[],
): number {
  const level = Math.min(1, Math.max(0, channel.level));
  if (channel.muted) return 0;
  if (anySoloed(channels)) return channel.solo ? level : 0;
  return level;
}

/** Gains for every channel, in order. */
export function mixGains(channels: readonly StemChannel[]): number[] {
  return channels.map((channel) => effectiveGain(channel, channels));
}

export const DEFAULT_CHANNELS: StemChannel[] = [
  { name: "vocals", level: 1, muted: false, solo: false },
  { name: "drums", level: 1, muted: false, solo: false },
  { name: "bass", level: 1, muted: false, solo: false },
  { name: "other", level: 1, muted: false, solo: false },
];

/** Keeps four stems locked to one transport position. */
export function driftMs(primaryMs: number, stemMs: number): number {
  return Math.abs(primaryMs - stemMs);
}

/** A stem whose clock drifted further than this gets re-seeked. */
export const MAX_STEM_DRIFT_MS = 120;
