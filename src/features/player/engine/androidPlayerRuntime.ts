import { usePlayerStore } from "../store/playerStore";
import { ApiError } from "@/shared/api";
import { log } from "@/shared/utils/logger";
import { audioCache } from "@/shared/storage/audioCache";
import { getAndroidBridge, onNativeEvent, registerMediaCommandHandler } from "@/platform";
import type { Track } from "@/shared/types";
import { resolvePlaybackStream, type ResolvedPlaybackStream } from "./playbackSource";
import {
  autoCrossfadeWindowMs,
  transitionSpec,
  CROSSFADE_MAX_MS,
  CROSSFADE_MIN_MS,
} from "./transitions";
import { computeNextIndex, peekAutoNextTrack } from "./queueNext";
import { useEqualizerSettingsStore } from "../store/equalizerSettingsStore";
import {
  startBackgroundAudioKeepAlive,
  stopBackgroundAudioKeepAlive,
} from "./backgroundAudio";

/** When false, native playback never caches audio to disk (only Download saves). */
const AUTO_CACHE_AUDIO = false;

interface NativeAudioState {
  ok?: boolean;
  trackId?: string | null;
  status?: "idle" | "buffering" | "playing" | "paused" | "ended" | "error";
  positionMs?: number;
  durationMs?: number;
  bufferedMs?: number;
  playbackRate?: number;
  error?: string | null;
}

interface NativeLoadPayload {
  url: string;
  mimeType: string;
  trackId: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  durationMs: number;
  startMs: number;
}

/**
 * Android playback engine.
 *
 * The renderer keeps owning queue, repeat/shuffle, lyrics, telemetry and
 * persistence. Audio decoding/output, background playback, audio focus,
 * notification and lock-screen controls are delegated to the native Media3
 * ExoPlayer service, whose real playback clock is polled back into the same
 * player store the desktop HTMLAudioElement runtime feeds.
 */
export class AndroidPlayerRuntime {
  private bridge = getAndroidBridge()!;
  private currentTrackId: string | null = null;
  private loadEpoch = 0;
  private loadAbort: AbortController | null = null;
  private currentSessionExpiresAt: number | null = null;
  private pendingStartPositionMs = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Native state poll cadence. Fast while something is audible (position,
   * fades and caching all key off it), slow while paused/idle — a paused
   * player still reconciles status and the sleep deadline, just once a
   * second instead of ~7x/s.
   */
  private pollIntervalMs = 150;
  private static readonly POLL_ACTIVE_MS = 150;
  private static readonly POLL_IDLE_MS = 1000;
  private unsubscribe: (() => void) | null = null;
  private sleepUnsubscribe: (() => void) | null = null;
  private endedTrackId: string | null = null;
  private erroredTrackId: string | null = null;
  private cacheRequested = new Set<string>();
  private activeStream: ResolvedPlaybackStream | null = null;
  private preloaded = new Map<string, { stream: ResolvedPlaybackStream; at: number }>();
  /** Mirrors the last volume pushed to the native player so ramps know where to start. */
  private nativeVolume = 1;
  private rampTimer: ReturnType<typeof setTimeout> | null = null;
  /** Track whose end-of-song fade-out already ran (once per track). */
  private endFadeTrackId: string | null = null;
  /** Incoming track prepared/blended on the native transition player. */
  private crossfadeTrackId: string | null = null;
  /** Guards overlapping async starts while an incoming stream resolves. */
  private crossfadeInFlight = false;
  private crossfadeEpoch = 0;
  /** Track the native side already plays after a crossfade promotion; the
   *  queue advance must adopt it instead of reloading it. */
  private adoptTrackId: string | null = null;
  private nextTrackEpoch = 0;
  private previousTrackEpoch = 0;
  public onEnded?: () => void;
  public onError?: (info: { trackId: string; message: string }) => void;

  constructor() {
    registerMediaCommandHandler((command) => {
      const store = usePlayerStore.getState();
      switch (command.type) {
        case "next":
          void store.dispatch({ type: "SKIP_NEXT" });
          break;
        case "prev":
          void store.dispatch({ type: "SKIP_PREVIOUS" });
          break;
        case "seek":
          store.dispatch({ type: "SEEK_COMMITTED", positionMs: command.positionMs });
          break;
        default:
          break;
      }
    });

    this.setNativeVolume(usePlayerStore.getState().volume);
    this.bridge.audioSetCacheLimit(audioCache.getLimitBytes());
    const equalizer = useEqualizerSettingsStore.getState();
    this.bridge.audioSetEqualizer?.(equalizer.enabled, JSON.stringify(equalizer.gains));
    useEqualizerSettingsStore.subscribe((state) => {
      this.bridge.audioSetEqualizer?.(state.enabled, JSON.stringify(state.gains));
    });
    this.applyPlaybackRateAndPitch();

    this.unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (state.volume !== prev.volume) {
        // A direct user volume change wins over any in-flight transition ramp.
        this.cancelRamp();
        this.setNativeVolume(state.volume);
      }
      if (state.sleepTimerEndsAtMs !== prev.sleepTimerEndsAtMs) {
        // Enforce natively so it fires with the screen off / app backgrounded.
        this.bridge.audioSleepAt(state.sleepTimerEndsAtMs ?? 0);
      }
      if (
        state.playbackRate !== prev.playbackRate ||
        state.isPitchLinked !== prev.isPitchLinked ||
        state.pitchSemitones !== prev.pitchSemitones ||
        state.isReverbEnabled !== prev.isReverbEnabled ||
        state.reverbLevel !== prev.reverbLevel
      ) {
        this.applyPlaybackRateAndPitch();
      }
    });

    // Native pauses at the deadline; mirror that into the store (the poll has
    // already flipped status to paused, this just clears the countdown).
    this.sleepUnsubscribe = onNativeEvent("sleepTimerFired", () => {
      usePlayerStore.getState().setSleepTimer(null);
    });

    onNativeEvent("playbackAutoAdvanced", (payload) => {
      const trackId = this.readNativeTrackId(payload);
      if (trackId) this.handleNativeAutoAdvance(trackId);
    });
    onNativeEvent("playbackNextAdvanced", (payload) => {
      const trackId = this.readNativeTrackId(payload);
      if (trackId) this.handleNativeNextAdvance(trackId);
    });
    onNativeEvent("playbackPreviousAdvanced", (payload) => {
      const trackId = this.readNativeTrackId(payload);
      if (trackId) this.handleNativePreviousAdvance(trackId);
    });

    onNativeEvent("crossfadeCompleted", (payload) => {
      let trackId: string | null = null;
      if (typeof payload === "string") {
        try {
          const parsed: unknown = JSON.parse(payload);
          trackId = typeof parsed === "string" ? parsed : null;
        } catch {
          trackId = payload;
        }
      } else if (payload && typeof payload === "object" && "trackId" in payload) {
        trackId = String((payload as { trackId: unknown }).trackId);
      }
      if (!trackId || trackId !== this.crossfadeTrackId) return;
      this.crossfadeTrackId = null;
      this.crossfadeInFlight = false;
      const store = usePlayerStore.getState();
      this.nativeVolume = store.volume;
      this.adoptTrackId = trackId;
      log("green", "audio", "native crossfade completed - advancing queue");
      store.dispatch({ type: "SKIP_NEXT", isAutoEnd: true });
    });

    this.reconcileWithNative();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    log("green", "boot", "android native player runtime initialized");
  }

  public getCurrentTrackId(): string | null {
    return this.currentTrackId;
  }

  public hasLoadedSourceFor(trackId: string): boolean {
    const expired =
      this.currentSessionExpiresAt !== null &&
      Date.now() >= this.currentSessionExpiresAt - 15_000;
    return this.currentTrackId === trackId && !expired;
  }

  public setPendingSeek(positionMs: number): void {
    this.pendingStartPositionMs = positionMs;
    usePlayerStore.getState().setPosition(positionMs);
    this.bridge.audioSeek(positionMs);
  }

  /** iOS only: keep the WKWebView renderer out of suspension while audio plays. */
  private startRendererKeepAlive(): void {
    if (this.bridge.getPlatform() === "ios") startBackgroundAudioKeepAlive();
  }

  private stopRendererKeepAlive(): void {
    if (this.bridge.getPlatform() === "ios") stopBackgroundAudioKeepAlive();
  }

  private setNativeVolume(next: number): void {
    this.nativeVolume = Math.max(0, Math.min(1, next));
    this.bridge.audioSetVolume(this.nativeVolume);
  }

  private cancelRamp(): void {
    if (this.rampTimer !== null) {
      clearTimeout(this.rampTimer);
      this.rampTimer = null;
    }
  }

  public async preloadPreviousTrack(track: Track): Promise<void> {
    const preloadEpoch = ++this.previousTrackEpoch;
    this.bridge.audioSetPreviousTrack?.(null);
    try {
      const cached = this.preloaded.get(track.id);
      let stream = cached?.stream;
      if (!stream || (stream.expiresAtMs !== null && Date.now() >= stream.expiresAtMs - 15_000)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          stream = await resolvePlaybackStream(
            track,
            controller.signal,
            "playback",
            usePlayerStore.getState().audioQuality,
          );
        } finally {
          clearTimeout(timeout);
        }
      }
      if (preloadEpoch !== this.previousTrackEpoch) return;
      if (stream.expiresAtMs !== null && Date.now() >= stream.expiresAtMs - 15_000) return;
      this.bridge.audioSetPreviousTrack?.(
        JSON.stringify({
          url: stream.url,
          mimeType: stream.mimeType,
          trackId: track.id,
          title: track.title,
          artist: track.artists || "",
          album:
            typeof track.album === "string"
              ? track.album
              : (track.album as { title?: string } | undefined)?.title || "Liner",
          coverUrl: track.coverUrl || "",
          durationMs: track.durationMs || 0,
          startMs: 0,
        } satisfies NativeLoadPayload),
      );
    } catch (error) {
      if (preloadEpoch === this.previousTrackEpoch) {
        log(
          "yellow",
          "preload",
          `previous-track resolution failed for "${track.title}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  public clearPreloadedTrack(): void {
    this.nextTrackEpoch += 1;
    this.bridge.audioSetNextTrack?.(null, false);
  }

  public clearPreloadedPreviousTrack(): void {
    this.previousTrackEpoch += 1;
    this.bridge.audioSetPreviousTrack?.(null);
  }

  private readNativeTrackId(payload: unknown): string | null {
    if (payload && typeof payload === "object" && "trackId" in payload) {
      const value = (payload as { trackId: unknown }).trackId;
      return typeof value === "string" && value ? value : null;
    }
    if (typeof payload !== "string") return null;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && "trackId" in parsed) {
        const value = (parsed as { trackId: unknown }).trackId;
        return typeof value === "string" && value ? value : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  private handleNativeAutoAdvance(trackId: string): void {
    const next = peekAutoNextTrack(usePlayerStore.getState());
    if (next?.id !== trackId) return;
    this.adoptTrackId = trackId;
    usePlayerStore.getState().dispatch({ type: "SKIP_NEXT", isAutoEnd: true });
  }

  private handleNativeNextAdvance(trackId: string): void {
    const store = usePlayerStore.getState();
    const nextIndex = computeNextIndex(store);
    if (nextIndex === null || store.queue[nextIndex]?.id !== trackId) return;
    this.adoptTrackId = trackId;
    store.dispatch({ type: "SKIP_NEXT" });
  }

  private handleNativePreviousAdvance(trackId: string): void {
    const store = usePlayerStore.getState();
    const previousIndex =
      store.currentIndex > 0
        ? store.currentIndex - 1
        : store.repeat === "all" && store.queue.length > 0
          ? store.queue.length - 1
          : store.currentIndex;
    if (store.queue[previousIndex]?.id !== trackId || trackId === store.currentTrack?.id) return;
    this.adoptTrackId = trackId;
    store.dispatch({ type: "SKIP_PREVIOUS" });
  }

  /**
   * Eased volume ramp on the native player, mirroring the web runtime's
   * fadeVolume so transition presets sound the same on both engines.
   * Resolves when the ramp completes.
   */
  private rampNativeVolume(target: number, durationMs: number): Promise<void> {
    this.cancelRamp();
    const clampedTarget = Math.max(0, Math.min(1, target));
    const startVolume = this.nativeVolume;
    const diff = clampedTarget - startVolume;
    if (Math.abs(diff) < 0.001 || durationMs <= 0) {
      this.setNativeVolume(clampedTarget);
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const startTime = performance.now();
      const tick = () => {
        const progress = Math.min((performance.now() - startTime) / durationMs, 1);
        const eased = 0.5 - 0.5 * Math.cos(progress * Math.PI);
        this.setNativeVolume(startVolume + diff * eased);
        if (progress < 1) {
          this.rampTimer = setTimeout(tick, 32);
        } else {
          this.rampTimer = null;
          this.setNativeVolume(clampedTarget);
          resolve();
        }
      };
      this.rampTimer = setTimeout(tick, 32);
    });
  }

  /**
   * Fades the outgoing song to silence before a manual skip switches tracks.
   * Resolves immediately when no fade-out is configured or nothing is audible.
   */
  private fadeOutForTransition(epoch: number): Promise<void> {
    const fadeOutMs = transitionSpec(
      usePlayerStore.getState().transitionPreset,
    ).fadeOutMs;
    if (fadeOutMs <= 0 || epoch !== this.loadEpoch) return Promise.resolve();
    const state = this.readState();
    if (!state?.trackId || state.status !== "playing") return Promise.resolve();

    log("cyan", "audio", `native transition fade-out (${fadeOutMs}ms)`);
    return Promise.race([
      this.rampNativeVolume(0, fadeOutMs),
      new Promise<void>((resolve) => setTimeout(resolve, fadeOutMs + 80)),
    ]);
  }

  /** Starts the outgoing fade-out over the final stretch of the current song. */
  private maybeStartEndFade(state: NativeAudioState): void {
    // An active overlapping crossfade owns the tail; the sequential fade is
    // only the fallback for when no blend could start.
    if (this.crossfadeTrackId !== null) return;
    const fadeOutMs = transitionSpec(
      usePlayerStore.getState().transitionPreset,
    ).fadeOutMs;
    if (fadeOutMs <= 0 || !this.currentTrackId) return;
    if (this.endFadeTrackId === this.currentTrackId) return;
    if (state.status !== "playing") return;

    const duration = state.durationMs ?? 0;
    const position = state.positionMs ?? 0;
    if (duration <= 0) return;

    const remainingMs = duration - position;
    if (remainingMs <= 0 || remainingMs > fadeOutMs) return;

    this.endFadeTrackId = this.currentTrackId;
    log("cyan", "audio", `native end-of-song fade-out (${fadeOutMs}ms)`);
    void this.rampNativeVolume(0, remainingMs);
  }

  /**
   * Overlapping-crossfade trigger: once the outgoing song enters the possible
   * blend window, resolve the incoming stream and hand it to the native
   * transition player, which blends and promotes it natively (works with the
   * screen off). The window is fitted to both songs up front and re-fitted to
   * the real remaining time at the moment the blend is armed.
   */
  private maybeStartCrossfade(state: NativeAudioState): void {
    const spec = transitionSpec(usePlayerStore.getState().transitionPreset);
    if (!spec.overlap || this.crossfadeTrackId || this.crossfadeInFlight) return;

    const duration = state.durationMs ?? 0;
    const position = state.positionMs ?? 0;
    if (duration <= 0) return;
    const remainingMs = duration - position;
    if (remainingMs <= 0 || remainingMs > CROSSFADE_MAX_MS) return;

    const next = peekAutoNextTrack(usePlayerStore.getState());
    if (!next) return;
    const windowMs = autoCrossfadeWindowMs(remainingMs, next.durationMs);
    if (windowMs <= 0) return;
    void this.startCrossfade(next, windowMs);
  }

  private async startCrossfade(next: Track, windowMs: number): Promise<void> {
    this.crossfadeInFlight = true;
    const epoch = ++this.crossfadeEpoch;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      const stream = await resolvePlaybackStream(
        next,
        controller.signal,
        "playback",
        usePlayerStore.getState().audioQuality,
      );
      clearTimeout(timeout);
      if (epoch !== this.crossfadeEpoch) return;
      if (stream.expiresAtMs !== null && Date.now() >= stream.expiresAtMs - 15_000) return;
      const store = usePlayerStore.getState();
      if (store.status !== "playing" || store.currentTrack?.id !== this.currentTrackId) return;
      const live = this.readState();
      if (!live) return;
      const remainingNow = (live.durationMs ?? 0) - (live.positionMs ?? 0);
      if (remainingNow < CROSSFADE_MIN_MS) return;

      const payload: NativeLoadPayload = {
        url: stream.url,
        mimeType: stream.mimeType,
        trackId: next.id,
        title: next.title,
        artist: next.artists || "",
        album:
          typeof next.album === "string"
            ? next.album
            : (next.album as { title?: string } | undefined)?.title || "Liner",
        coverUrl: next.coverUrl || "",
        durationMs: next.durationMs || 0,
        startMs: 0,
      };
      this.bridge.audioCrossfadeLoad(JSON.stringify(payload));

      const window = Math.min(windowMs, remainingNow);
      this.bridge.audioCrossfadeStart(window);
      this.crossfadeTrackId = next.id;
      log("cyan", "audio", `native crossfade armed (${window}ms into "${next.title}")`);
    } catch (err) {
      if (epoch === this.crossfadeEpoch) {
        log(
          "yellow",
          "audio",
          `crossfade skipped for "${next.title}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.crossfadeInFlight = false;
    }
  }

  private cancelCrossfade(): void {
    this.crossfadeEpoch += 1;
    this.crossfadeInFlight = false;
    if (this.crossfadeTrackId === null) return;
    this.crossfadeTrackId = null;
    this.bridge.audioCrossfadeCancel();
    this.nativeVolume = usePlayerStore.getState().volume;
    log("cyan", "audio", "native crossfade cancelled");
  }

  public async preloadTrack(track: Track, autoAdvance = true): Promise<void> {
    const preloadEpoch = ++this.nextTrackEpoch;
    this.bridge.audioSetNextTrack?.(null, false);
    if (this.currentTrackId === track.id) return;
    try {
      const cached = this.preloaded.get(track.id);
      let stream = cached?.stream;
      if (!stream || (stream.expiresAtMs !== null && Date.now() >= stream.expiresAtMs - 15_000)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        try {
          stream = await resolvePlaybackStream(
            track,
            controller.signal,
            "playback",
            usePlayerStore.getState().audioQuality,
          );
        } finally {
          clearTimeout(timeout);
        }
      }
      if (preloadEpoch !== this.nextTrackEpoch) return;
      if (stream.expiresAtMs !== null && Date.now() >= stream.expiresAtMs - 15_000) return;
      this.preloaded.set(track.id, { stream, at: Date.now() });
      this.bridge.audioSetNextTrack?.(
        JSON.stringify({
          url: stream.url,
          mimeType: stream.mimeType,
          trackId: track.id,
          title: track.title,
          artist: track.artists || "",
          album:
            typeof track.album === "string"
              ? track.album
              : (track.album as { title?: string } | undefined)?.title || "Liner",
          coverUrl: track.coverUrl || "",
          durationMs: track.durationMs || 0,
          startMs: 0,
        } satisfies NativeLoadPayload),
        autoAdvance,
      );
      // keep the map bounded; a queue is at most a few dozen tracks
      if (this.preloaded.size > 12) {
        const oldest = [...this.preloaded.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this.preloaded.delete(oldest[0]);
      }
      log("cyan", "preload", `resolved next stream for "${track.title}"`);
    } catch (err) {
      if (preloadEpoch !== this.nextTrackEpoch) return;
      log(
        "yellow",
        "preload",
        `next stream resolution failed for "${track.title}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async loadAndPlay(track: Track, startPositionMs = 0): Promise<void> {
    // Start synchronously from the playback gesture so iOS can grant the
    // background media assertion before stream resolution awaits network I/O.
    this.startRendererKeepAlive();
    if (this.adoptTrackId === track.id) {
      // Queue advance after a completed crossfade: the native side is already
      // playing this track mid-song — adopt it instead of reloading.
      this.adoptTrackId = null;
      const live = this.readState();
      const store = usePlayerStore.getState();
      if (
        live?.trackId === track.id &&
        (live.status === "playing" || live.status === "paused" || live.status === "buffering")
      ) {
        this.currentTrackId = track.id;
        this.endedTrackId = null;
        this.currentSessionExpiresAt = null;
        this.activeStream = null;
        if (typeof live.positionMs === "number" && live.positionMs >= 0) {
          store.setPosition(live.positionMs);
        }
        store.setStatus(live.status === "buffering" ? "loading" : live.status);
        log("green", "playback", `adopted native track "${track.title}"`);
        return;
      }
    }
    this.cancelCrossfade();
    const epoch = ++this.loadEpoch;

    if (this.currentTrackId !== track.id) {
      // Fade the outgoing song before switching (instant when preset is "off").
      await this.fadeOutForTransition(epoch);
      if (epoch !== this.loadEpoch) return;
    }

    this.loadAbort?.abort();
    const controller = new AbortController();
    this.loadAbort = controller;

    if (this.currentTrackId !== track.id) {
      this.erroredTrackId = null;
    }
    this.currentTrackId = track.id;
    this.endedTrackId = null;
    this.endFadeTrackId = null;
    this.currentSessionExpiresAt = null;
    this.activeStream = null;
    this.cacheRequested.delete(track.id);
    this.pendingStartPositionMs = startPositionMs;

    const store = usePlayerStore.getState();
    const fadeInMs = transitionSpec(store.transitionPreset).fadeInMs;
    store.setStatus("loading", null);
    store.setPosition(startPositionMs);
    store.setDuration(track.durationMs ?? 0);
    this.bridge.requestNotificationPermission();
    this.bridge.setKeepScreenOn(false);
    // Start from silence when a fade-in is configured; the ramp fires once the
    // native player has the new stream attached below.
    this.cancelRamp();
    this.setNativeVolume(fadeInMs > 0 ? 0 : store.volume);
    this.applyPlaybackRateAndPitch();

    try {
      const cached = this.preloaded.get(track.id);
      let stream: ResolvedPlaybackStream;
      if (cached && (cached.stream.expiresAtMs === null || Date.now() < cached.stream.expiresAtMs - 15_000)) {
        stream = cached.stream;
        log("cyan", "playback", `using pre-resolved stream for "${track.title}"`);
      } else {
        stream = await resolvePlaybackStream(
          track,
          controller.signal,
          "playback",
          usePlayerStore.getState().audioQuality,
        );
      }
      this.preloaded.delete(track.id);

      if (epoch !== this.loadEpoch || controller.signal.aborted) return;

      this.currentSessionExpiresAt = stream.expiresAtMs;
      this.activeStream = stream;

      const payload: NativeLoadPayload = {
        url: stream.url,
        mimeType: stream.mimeType,
        trackId: track.id,
        title: track.title,
        artist: track.artists || "",
        album:
          typeof track.album === "string"
            ? track.album
            : (track.album as { title?: string } | undefined)?.title || "Liner",
        coverUrl: track.coverUrl || "",
        durationMs: track.durationMs || 0,
        startMs: startPositionMs,
      };
      this.bridge.audioLoad(JSON.stringify(payload));
      if (fadeInMs > 0 && epoch === this.loadEpoch) {
        void this.rampNativeVolume(store.volume, fadeInMs);
      }
      log(
        "green",
        "playback",
        `native stream attached: ${stream.codec} ${stream.bitrate} bps (${track.title})`,
      );
    } catch (err) {
      if (epoch !== this.loadEpoch || controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Playback failed to start.";
      console.error("[AndroidPlaybackError]", track.id, err);
      usePlayerStore.getState().setStatus("error", message);
      this.onError?.({ trackId: track.id, message });
      this.stopRendererKeepAlive();
    }
  }

  public pause(): void {
    this.cancelCrossfade();
    this.loadEpoch += 1;
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.cancelRamp();
    this.endFadeTrackId = null;
    this.bridge.audioPause();
    this.stopRendererKeepAlive();
    usePlayerStore.getState().setStatus("paused");
    this.bridge.setKeepScreenOn(false);
  }

  public resume(): void {
    const store = usePlayerStore.getState();
    if (!store.currentTrack) return;
    if (!this.hasLoadedSourceFor(store.currentTrack.id)) {
      void this.loadAndPlay(store.currentTrack, store.positionMs);
      return;
    }
    this.bridge.audioResume();
    this.startRendererKeepAlive();
    store.setStatus("playing");
    this.bridge.setKeepScreenOn(false);
  }

  public seek(positionMs: number): void {
    this.cancelCrossfade();
    const store = usePlayerStore.getState();
    // Seeking away from the tail cancels an in-progress end-of-song fade so the
    // track isn't left muted; the next poll restarts it if we land back in the
    // fade-out window.
    if (this.endFadeTrackId !== null) {
      this.endFadeTrackId = null;
      this.cancelRamp();
      if (store.status === "playing") this.setNativeVolume(store.volume);
    }
    const duration = store.durationMs || store.currentTrack?.durationMs || 0;
    const next = Math.round(Math.max(0, Math.min(duration || positionMs, positionMs)));
    store.setPosition(next);
    if (!store.currentTrack) return;
    if (!this.hasLoadedSourceFor(store.currentTrack.id)) {
      if (store.status === "playing") void this.loadAndPlay(store.currentTrack, next);
      return;
    }
    this.bridge.audioSeek(next);
  }

  public cancelPendingLoad(): void {
    this.cancelCrossfade();
    this.loadEpoch += 1;
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.cancelRamp();
    this.endFadeTrackId = null;
    this.currentTrackId = null;
    this.currentSessionExpiresAt = null;
    this.activeStream = null;
    this.endedTrackId = null;
    this.bridge.audioStop();
    this.bridge.setKeepScreenOn(false);
    this.stopRendererKeepAlive();
    usePlayerStore.getState().setStatus("paused");
  }

  /**
   * Full teardown (sign-out / reset): the native side clears its media
   * session and notification when the audio is stopped.
   */
  public stop(): void {
    this.cancelPendingLoad();
  }

  public applyPlaybackRateAndPitch(): void {
    const store = usePlayerStore.getState();
    const rate = Math.min(2, Math.max(0.5, store.playbackRate || 1));
    const semitones = store.isPitchLinked
      ? 12 * Math.log2(rate)
      : Math.min(12, Math.max(-12, store.pitchSemitones || 0));
    this.bridge.audioSetSpeed(rate);
    this.bridge.audioSetPitch(Number(semitones.toFixed(3)));
    this.bridge.audioSetReverb(store.isReverbEnabled ? store.reverbLevel : 0);
  }

  private reconcileWithNative(): void {
    const state = this.readState();
    if (!state?.trackId) return;
    const store = usePlayerStore.getState();
    if (store.currentTrack?.id === state.trackId) {
      this.currentTrackId = state.trackId;
      if (typeof state.durationMs === "number" && state.durationMs > 0) {
        store.setDuration(state.durationMs);
      }
      if (typeof state.positionMs === "number" && state.positionMs >= 0) {
        store.setPosition(state.positionMs);
      }
      if (state.status === "playing") {
        store.setStatus("playing");
      } else if (state.status === "buffering") {
        store.setStatus("loading");
      } else if (state.status === "paused") {
        store.setStatus("paused");
      }
    } else if (!store.currentTrack) {
      // native still has a session from a recreated activity but the store lost it
      this.bridge.audioStop();
    }
  }

  private readState(): NativeAudioState | null {
    try {
      const raw = this.bridge.audioState();
      if (!raw) return null;
      return JSON.parse(raw) as NativeAudioState;
    } catch {
      return null;
    }
  }

  private poll(): void {
    if (!this.currentTrackId) return;
    const state = this.readState();
    if (!state || !state.trackId) return;
    if (state.trackId !== this.currentTrackId) {
      const next = peekAutoNextTrack(usePlayerStore.getState());
      if (next?.id === state.trackId) {
        this.handleNativeAutoAdvance(state.trackId);
      } else {
        this.handleNativePreviousAdvance(state.trackId);
      }
      return;
    }
    const store = usePlayerStore.getState();

    if (typeof state.durationMs === "number" && state.durationMs > 0) {
      if (Math.abs(state.durationMs - store.durationMs) > 500) {
        store.setDuration(state.durationMs);
      }
    }

    if (typeof state.positionMs === "number" && state.positionMs >= 0) {
      if (Math.abs(state.positionMs - store.positionMs) > 60) {
        store.setPosition(state.positionMs);
      }
    }

    switch (state.status) {
      case "playing":
        if (store.status !== "playing") store.setStatus("playing");
        this.maybeStartCrossfade(state);
        this.maybeStartEndFade(state);
        this.maybeCacheAudio();
        break;
      case "buffering":
        if (store.status !== "loading") store.setStatus("loading");
        break;
      case "paused":
        if (store.status === "playing" || store.status === "loading") store.setStatus("paused");
        break;
      case "ended":
        this.handleEnded(state.trackId);
        break;
      case "error": {
        const message = state.error || "Audio playback error";
        if (this.erroredTrackId !== state.trackId) {
          this.erroredTrackId = state.trackId;
          store.setStatus("error", message);
          this.onError?.({ trackId: state.trackId, message });
        }
        break;
      }
      default:
        break;
    }

    this.setPollCadence(
      state.status === "playing"
        ? AndroidPlayerRuntime.POLL_ACTIVE_MS
        : AndroidPlayerRuntime.POLL_IDLE_MS,
    );
  }

  private setPollCadence(intervalMs: number): void {
    if (intervalMs === this.pollIntervalMs || !this.pollTimer) return;
    this.pollIntervalMs = intervalMs;
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
  }

  private handleEnded(trackId: string): void {
    if (this.endedTrackId === trackId) return;
    this.endedTrackId = trackId;
    log("cyan", "audio", "native playback ended - advancing queue");
    this.bridge.setKeepScreenOn(false);
    // The queue advances immediately; poll fast again so the next track's
    // position doesn't wait out an idle interval.
    this.setPollCadence(AndroidPlayerRuntime.POLL_ACTIVE_MS);
    this.onEnded?.();
    usePlayerStore.getState().dispatch({ type: "SKIP_NEXT", isAutoEnd: true });
  }

  private maybeCacheAudio(): void {
    if (!AUTO_CACHE_AUDIO) return;
    if (!this.activeStream || !this.currentTrackId) return;
    if (this.cacheRequested.has(this.currentTrackId)) return;
    this.cacheRequested.add(this.currentTrackId);
    this.bridge.audioCache(
      this.activeStream.url,
      this.currentTrackId,
      this.activeStream.mimeType,
      audioCache.getLimitBytes(),
    );
  }
}
