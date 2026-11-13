import type { Stem, StemName } from "./api";
import { DEFAULT_CHANNELS, effectiveGain, type StemChannel } from "./mix";

/**
 * Four-track stem mixer.
 *
 * One media element and one GainNode per stem, all fed from a single
 * AudioContext in the renderer, so mute/solo/faders are real gain changes —
 * not restarts, not volume guesses. Playback is kept in sync off stem 0: the
 * others are re-seeked only when drift passes the click threshold.
 *
 * Stems arrive as local file paths (cached by the main process) or as remote
 * URLs when caching is unavailable (the website), so the engine accepts both.
 */

export interface LoadedStem {
  name: StemName;
  /** file:// path or https:// url. */
  src: string;
}

interface StemVoice {
  name: StemName;
  element: HTMLAudioElement;
  gain: GainNode;
  source: MediaElementAudioSourceNode;
}

export class StemEngine {
  private context: AudioContext | null = null;
  private voices: StemVoice[] = [];
  private syncTimer: number | null = null;
  private onTick: ((positionMs: number, durationMs: number) => void) | null = null;

  get isLoaded(): boolean {
    return this.voices.length > 0;
  }

  get isPlaying(): boolean {
    return this.voices.some((voice) => !voice.element.paused);
  }

  /** Builds the graph. Safe to call again after `dispose()`. */
  load(stems: LoadedStem[]): void {
    this.dispose();
    if (stems.length === 0) return;

    const context = new AudioContext();
    this.context = context;
    this.voices = stems.map((stem) => {
      const element = new Audio();
      element.src = stem.src;
      element.preload = "auto";
      // Only remote stems need CORS; asking for it on a file:// source makes
      // the element refuse to load the cached file.
      if (/^https?:/i.test(stem.src)) element.crossOrigin = "anonymous";
      const source = context.createMediaElementSource(element);
      const gain = context.createGain();
      gain.gain.value = 1;
      source.connect(gain).connect(context.destination);
      return { name: stem.name, element, gain, source };
    });
  }

  /** Applies the mixer state (fader/mute/solo) to the graph. */
  apply(channels: readonly StemChannel[]): void {
    if (!this.context) return;
    for (const voice of this.voices) {
      const channel =
        channels.find((candidate) => candidate.name === voice.name) ?? DEFAULT_CHANNELS[0];
      const target = effectiveGain(channel, channels);
      // Short ramp: an instant jump clicks on every fader move.
      voice.gain.gain.setTargetAtTime(target, this.context.currentTime, 0.015);
    }
  }

  async play(positionMs?: number): Promise<void> {
    if (!this.context) return;
    if (this.context.state === "suspended") await this.context.resume();
    const startAt = positionMs ?? this.currentPositionMs() / 1000;
    for (const voice of this.voices) {
      if (positionMs !== undefined) {
        try {
          voice.element.currentTime = startAt;
        } catch {
          // metadata not ready yet; the loadedmetadata handler catches up
        }
      }
      await voice.element.play().catch(() => undefined);
    }
    this.startSync();
  }

  pause(): void {
    for (const voice of this.voices) voice.element.pause();
    this.stopSync();
  }

  seek(positionMs: number): void {
    for (const voice of this.voices) {
      try {
        voice.element.currentTime = positionMs / 1000;
      } catch {
        // ignore before metadata
      }
    }
  }

  currentPositionMs(): number {
    return this.voices[0] ? this.voices[0].element.currentTime * 1000 : 0;
  }

  durationMs(): number {
    const duration = this.voices[0]?.element.duration ?? 0;
    return Number.isFinite(duration) ? duration * 1000 : 0;
  }

  /** Position/duration updates for the UI, ~4×/s. */
  subscribe(listener: (positionMs: number, durationMs: number) => void): () => void {
    this.onTick = listener;
    this.startSync();
    return () => {
      if (this.onTick === listener) this.onTick = null;
      this.stopSync();
    };
  }

  dispose(): void {
    this.stopSync();
    for (const voice of this.voices) {
      try {
        voice.element.pause();
        voice.element.removeAttribute("src");
        voice.element.load();
        voice.source.disconnect();
        voice.gain.disconnect();
      } catch {
        // element already torn down
      }
    }
    this.voices = [];
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private startSync(): void {
    if (this.syncTimer !== null || !this.voices.length) return;
    this.syncTimer = window.setInterval(() => {
      const master = this.voices[0];
      if (!master) return;
      const masterMs = master.element.currentTime * 1000;
      for (const voice of this.voices.slice(1)) {
        if (voice.element.paused) continue;
        if (Math.abs(voice.element.currentTime * 1000 - masterMs) > 120) {
          voice.element.currentTime = masterMs / 1000;
        }
      }
      this.onTick?.(masterMs, this.durationMs());
    }, 250);
  }

  private stopSync(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

/** file:// paths from the cache, or the service URLs when not cached. */
export function toLoadedStems(
  stems: Stem[],
  cached: { name: string; path: string }[],
): LoadedStem[] {
  const byName = new Map(cached.map((stem) => [stem.name, stem.path]));
  return stems.map((stem) => ({
    name: stem.name,
    src: byName.get(stem.name) ?? stem.url,
  }));
}
