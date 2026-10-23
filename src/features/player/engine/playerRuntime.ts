import { usePlayerStore } from "../store/playerStore";
import { ApiError } from "@/shared/api";
import { log } from "@/shared/utils/logger";
import { telemetry } from "@/shared/telemetry";
import { linerDb, audioCache } from "@/shared/storage";
import { isStandaloneAudioFile } from "@/shared/storage/audioFormat";
import type { Track } from "@/shared/types";
import { pitchShifter } from "./pitchShifter";
import { resolvePlaybackStream, type PlaybackStream } from "./streamResolver";
import { downloadAudioBytes } from "@/shared/media/innertube";
import { autoCrossfadeWindowMs, equalPowerBlend, transitionSpec, CROSSFADE_MAX_MS } from "./transitions";
import { peekAutoNextTrack } from "./queueNext";

/**
 * When false, playback streams directly and never writes audio to disk; files
 * are saved only when the user presses the Download action. Flip to true to
 * restore the old background-caching behaviour.
 */
const AUTO_CACHE_AUDIO = false;

// error recovery tuning (see the audio "error" handler)
const RECOVERY_HOLD_MS = 3000;
const WAITING_GRACE_MS = 300; // a buffering hiccup shorter than this never shows // must play this far past a recovery before it may retry again

export class PlayerRuntime {
  private audio: HTMLAudioElement;
  private currentTrackId: string | null = null;
  private loadEpoch = 0;
  private loadAbortController: AbortController | null = null;
  private isResetting = false;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepTimerId: ReturnType<typeof setTimeout> | null = null;
  /** Track id whose end-of-song fade-out is already running (once per track). */
  private endFadeTrackId: string | null = null;
  /** Second element carrying the overlapping half of a crossfade. */
  private xAudio: HTMLAudioElement | null = null;
  private crossfade: {
    trackId: string;
    element: HTMLAudioElement;
    windowMs: number;
    startedAt: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private crossfadeEpoch = 0;
  /** Track already promoted from a crossfade; its queue advance adopts it. */
  private adoptTrackId: string | null = null;
  private stallStartTime: number | null = null;
  private loadStartTime = 0;
  private ttfbMs = 0;
  private activePlayPromise: Promise<void> | null = null;
  private activeBlobUrl: string | null = null;
  // track whose audio is attached to the element right now. During a skip the old
  // source stays attached (paused) until the next one is ready, so this can lag
  // currentTrackId for a moment.
  private attachedTrackId: string | null = null;
  private preloadingTrackId: string | null = null;
  private preloadingPromise: Promise<void> | null = null;
  private preloadAbortController: AbortController | null = null;
  private backgroundCacheAbortController: AbortController | null = null;
  private currentSessionExpiresAt: number | null = null;
  private recoveryAttempts = 0;
  // after a recovery, the retry budget only refills once playback gets past this
  // position: a "playing" event alone is not proof (a bad frame further on would
  // otherwise error -> recover -> play -> error forever, reloading every time)
  private recoveryHoldUntilMs: number | null = null;
  // a "waiting" only becomes the loading state if it lasts: a seek inside an already
  // loaded / cached track fires waiting -> playing within milliseconds, and flipping
  // the status for that re-animated the play / pause button on every seek
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;
  public onEnded?: () => void;
  public onError?: (info: { trackId: string; message: string }) => void;

  constructor() {
    const win = typeof window !== "undefined" ? (window as any) : null;
    let audio = (win?.__liner_audio || (typeof document !== "undefined" && document.getElementById("liner-audio"))) as HTMLAudioElement | null;
    if (!audio) {
      audio = new Audio();
      audio.id = "liner-audio";
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";
      if (typeof document !== "undefined") {
        document.body.appendChild(audio);
      }
    }
    if (win) {
      win.__liner_audio = audio;
    }
    this.audio = audio;
    this.setupAudioListeners(this.audio);

    const initialVolume = usePlayerStore.getState().volume;
    this.audio.volume = initialVolume;
    this.applyPlaybackRateAndPitch();
    log("cyan", "boot", `volume ${initialVolume}`);

    usePlayerStore.subscribe((state, prevState) => {
      if (state.status !== prevState.status) {
        this.syncMediaSessionState(state.status);
      }
      if (state.volume !== prevState.volume) {
        this.cancelFade();
        if (this.crossfade) {
          // Re-apply the running blend at the new user volume.
          const t = Math.min(
            1,
            (performance.now() - this.crossfade.startedAt) / this.crossfade.windowMs,
          );
          const { outgoing, incoming } = equalPowerBlend(t);
          if (!this.audio.paused) this.audio.volume = state.volume * outgoing;
          this.crossfade.element.volume = state.volume * incoming;
        } else if (!this.audio.paused) {
          this.audio.volume = state.volume;
        }
      }
      if (state.sleepTimerEndsAtMs !== prevState.sleepTimerEndsAtMs) {
        this.syncSleepTimer(state.sleepTimerEndsAtMs);
      }
      if (
        state.playbackRate !== prevState.playbackRate ||
        state.isPitchLinked !== prevState.isPitchLinked ||
        state.pitchSemitones !== prevState.pitchSemitones ||
        state.isReverbEnabled !== prevState.isReverbEnabled ||
        state.reverbLevel !== prevState.reverbLevel
      ) {
        const rate = state.playbackRate ?? 1;
        const preservesPitch = !state.isPitchLinked;
        this.applyPlaybackRateAndPitch(rate, preservesPitch);
      }
    });

    this.setupDeviceChangeListener();
    this.setupMediaSession();
    log("green", "boot", "player runtime initialized");
  }

  private setupDeviceChangeListener() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

    let initial = true;
    const onDeviceChange = () => {
      if (initial) {
        initial = false;
        return;
      }
      if (!usePlayerStore.getState().pauseOnDeviceChange) return;
      if (!this.audio.paused && usePlayerStore.getState().status === "playing") {
        this.pause();
      }
    };

    try {
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
      void navigator.mediaDevices.enumerateDevices().then(() => {
        initial = false;
      });
    } catch {
      // ignore unsupported environments
    }
  }

  private setupMediaSession() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler("play", () => {
        usePlayerStore.getState().dispatch({ type: "RESUME_REQUESTED" });
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        usePlayerStore.getState().dispatch({ type: "SKIP_PREVIOUS" });
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        usePlayerStore.getState().dispatch({ type: "SKIP_NEXT" });
      });
      navigator.mediaSession.setActionHandler("stop", () => {
        usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });
      });
      const seekBy = (deltaSeconds: number) => {
        const st = usePlayerStore.getState();
        const max = st.durationMs > 0 ? st.durationMs : Number.POSITIVE_INFINITY;
        const next = Math.min(max, Math.max(0, st.positionMs + deltaSeconds * 1000));
        st.dispatch({ type: "SEEK_COMMITTED", positionMs: Math.round(next) });
      };
      navigator.mediaSession.setActionHandler("seekbackward", (details) => {
        seekBy(-(details.seekOffset ?? 10));
      });
      navigator.mediaSession.setActionHandler("seekforward", (details) => {
        seekBy(details.seekOffset ?? 10);
      });
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.seekTime !== undefined && !Number.isNaN(details.seekTime)) {
          usePlayerStore.getState().dispatch({
            type: "SEEK_COMMITTED",
            positionMs: Math.round(details.seekTime * 1000),
          });
        }
      });
    } catch {
      // ignore unsupported media session actions
    }
  }

  // windows' media controls (and apps built on them, like FluentFlyout) read this.
  // "loading" between tracks still reports playing so the session never looks finished.
  private syncMediaSessionState(status: string) {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState =
        status === "playing" || status === "loading"
          ? "playing"
          : status === "paused"
            ? "paused"
            : "none";
      if (status === "idle") navigator.mediaSession.metadata = null;
    } catch {
      // ignore unsupported environments
    }
  }

  // progress / seek bar in the system controls
  private syncMediaSessionPosition() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession as MediaSession & {
      setPositionState?: (state?: MediaPositionState) => void;
    };
    if (typeof ms.setPositionState !== "function") return;
    if (this.attachedTrackId !== this.currentTrackId) return;
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      ms.setPositionState({
        duration,
        playbackRate: this.audio.playbackRate > 0 ? this.audio.playbackRate : 1,
        position: Math.min(duration, Math.max(0, this.audio.currentTime || 0)),
      });
    } catch {
      // ignore invalid transient states
    }
  }

  public updateMediaSessionMetadata(track: Track | null) {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artists,
        album: (track as { albumTitle?: string }).albumTitle || "Liner",
        artwork: track.coverUrl
          ? [
              { src: track.coverUrl, sizes: "96x96", type: "image/jpeg" },
              { src: track.coverUrl, sizes: "256x256", type: "image/jpeg" },
              { src: track.coverUrl, sizes: "512x512", type: "image/jpeg" },
            ]
          : [],
      });
    } catch {
      // ignore metadata assignment failures
    }
  }

  private setupAudioListeners(audioEl: HTMLAudioElement) {
    audioEl.addEventListener("timeupdate", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId) return;
      if (usePlayerStore.getState().status === "loading") return;
      if (Number.isNaN(audioEl.currentTime)) return;

      const posMs = Math.round(audioEl.currentTime * 1000);
      usePlayerStore.getState().setPosition(posMs);
      if (this.recoveryHoldUntilMs !== null && posMs >= this.recoveryHoldUntilMs) {
        this.recoveryHoldUntilMs = null;
        this.recoveryAttempts = 0;
      }
      this.maybeStartCrossfade(audioEl);
      this.maybeStartEndFade(audioEl);
    });

    audioEl.addEventListener("durationchange", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId) return;
      if (Number.isNaN(audioEl.duration) || audioEl.duration <= 0) return;

      usePlayerStore.getState().setDuration(Math.round(audioEl.duration * 1000));
      this.syncMediaSessionPosition();
    });

    for (const type of ["seeked", "ratechange", "play", "pause", "loadedmetadata"]) {
      audioEl.addEventListener(type, () => {
        if (this.isResetting || audioEl !== this.audio) return;
        this.syncMediaSessionPosition();
      });
    }

    audioEl.addEventListener("waiting", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      log("yellow", "audio", "buffering (waiting)");
      this.stallStartTime = performance.now();
      if (this.waitingTimer) clearTimeout(this.waitingTimer);
      this.waitingTimer = setTimeout(() => {
        this.waitingTimer = null;
        // still stuck: a real stall, show it
        if (audioEl !== this.audio || audioEl.paused || audioEl.readyState >= 3) return;
        if (usePlayerStore.getState().status === "playing") {
          usePlayerStore.getState().setStatus("loading");
        }
      }, WAITING_GRACE_MS);
    });

    // resumed (or never really stalled): drop a pending "loading"
    for (const type of ["playing", "seeked", "canplay", "pause", "emptied"]) {
      audioEl.addEventListener(type, () => {
        if (audioEl !== this.audio || !this.waitingTimer) return;
        if (type === "seeked" && audioEl.readyState < 3) return; // seeked but still no data
        clearTimeout(this.waitingTimer);
        this.waitingTimer = null;
      });
    }

    audioEl.addEventListener("ended", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId) return;
      if (this.attachedTrackId !== this.currentTrackId) return;
      // An active crossfade owns the handover; its completion advances the
      // queue exactly once.
      if (this.crossfade) return;

      // Ensure the track truly finished playing (not an empty media load or teardown artefact)
      const duration = audioEl.duration;
      const currentTime = audioEl.currentTime;
      if (duration > 0 && currentTime >= Math.max(0, duration - 1.5)) {
        log("cyan", "audio", "ended â€” skipping to next");
        this.onEnded?.();
        const state = usePlayerStore.getState();
        state.dispatch({ type: "SKIP_NEXT", isAutoEnd: true });
      }
    });

    audioEl.addEventListener("playing", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      log("green", "audio", "playing");
      if (this.recoveryHoldUntilMs === null) this.recoveryAttempts = 0;
      this.applyPlaybackRateAndPitch();

      if (this.stallStartTime !== null) {
        const stallDurationMs = Math.round(performance.now() - this.stallStartTime);
        if (stallDurationMs > 400) {
          telemetry.trackPlaybackHealth("STALL_BUFFERING", {
            trackId: this.currentTrackId || undefined,
            stallDurationMs,
          });
        }
        this.stallStartTime = null;
      }

      if (!this.currentTrackId || audioEl.paused) return;
      const currentStatus = usePlayerStore.getState().status;
      if (currentStatus !== "paused") {
        usePlayerStore.getState().setStatus("playing");
      }
    });

    audioEl.addEventListener("pause", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      log("cyan", "audio", "paused");
      const st = usePlayerStore.getState().status;
      if (st === "playing") {
        usePlayerStore.getState().setStatus("paused");
      }
    });

    audioEl.addEventListener("error", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId || !audioEl.src || audioEl.src === window.location.href) return;
      // the previous track's source is still attached while the next one loads
      if (this.attachedTrackId !== this.currentTrackId) return;

      const message = audioEl.error?.message || "Audio playback error";
      const code = audioEl.error?.code;
      console.error("[AudioElementError]", this.currentTrackId, code, message, audioEl.src);
      log("red", "audio", `error (code ${code}): ${message}`);

      const isDecode =
        code === (typeof MediaError !== "undefined" ? MediaError.MEDIA_ERR_DECODE : 3) ||
        code === (typeof MediaError !== "undefined" ? MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED : 4);

      if (isDecode) {
        telemetry.trackPlaybackHealth("MEDIA_DECODE_ERROR", {
          trackId: this.currentTrackId || undefined,
          errorMessage: message,
          details: { mediaErrorCode: code },
        });
      }

      if (this.activeBlobUrl) {
        URL.revokeObjectURL(this.activeBlobUrl);
        this.activeBlobUrl = null;
        void linerDb.deleteAudio(this.currentTrackId);
        audioCache.deleteAudio(this.currentTrackId);
      }

      const store = usePlayerStore.getState();
      const currentTrack = store.currentTrack;
      const posMs = Number.isFinite(audioEl.currentTime) && audioEl.currentTime > 0
        ? Math.round(audioEl.currentTime * 1000)
        : store.positionMs;

      if (
        currentTrack &&
        currentTrack.id === this.currentTrackId &&
        this.recoveryAttempts < 1
      ) {
        this.recoveryAttempts++;
        this.recoveryHoldUntilMs = posMs + RECOVERY_HOLD_MS;
        log("yellow", "playback", `audio error encountered â€” recovering via cache/stream at ${posMs}ms`);
        void this.loadAndPlay(currentTrack, posMs, true);
        return;
      }

      usePlayerStore.getState().setStatus("error", message);
      this.onError?.({ trackId: this.currentTrackId, message });
    });
  }

  public getCurrentTrackId(): string | null {
    return this.currentTrackId;
  }

  public hasLoadedSourceFor(trackId: string): boolean {
    const isExpired =
      this.currentSessionExpiresAt !== null &&
      Date.now() >= this.currentSessionExpiresAt - 15_000;
    return (
      this.currentTrackId === trackId &&
      this.attachedTrackId === trackId &&
      Boolean(this.audio.currentSrc || this.audio.src) &&
      this.audio.src !== window.location.href &&
      !this.audio.error &&
      !isExpired
    );
  }

  public applyPlaybackRateAndPitch(rate?: number, preservesPitch?: boolean): void {
    if (!this.audio) return;
    const store = usePlayerStore.getState();
    const targetRate = rate ?? store.playbackRate ?? 1;
    const targetPreserves =
      preservesPitch ?? (store.isPitchLinked !== undefined ? !store.isPitchLinked : true);

    try {
      this.audio.playbackRate = targetRate;
      this.audio.defaultPlaybackRate = targetRate;
      this.audio.preservesPitch = targetPreserves;
      (this.audio as any).mozPreservesPitch = targetPreserves;
      (this.audio as any).webkitPreservesPitch = targetPreserves;
    } catch {
      // Audio element not initialized or properties unsupported
    }

    try {
      const isPitchLinked = store.isPitchLinked ?? true;
      const pitchSemitones = store.pitchSemitones ?? 0;
      const isReverbEnabled = store.isReverbEnabled ?? false;
      const reverbLevel = store.reverbLevel ?? 0.35;
      const needsEffects = isReverbEnabled || (!isPitchLinked && Math.abs(pitchSemitones) >= 0.05);
      if (!needsEffects && !pitchShifter.isAttached()) return;
      pitchShifter.attach(this.audio);
      pitchShifter.update({
        pitchSemitones,
        isPitchLinked,
        isReverbEnabled,
        reverbLevel,
      });
    } catch (err) {
      console.error("[PlayerRuntime] applyPlaybackRateAndPitch error:", err);
    }
  }

  private cancelFade(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  private fadeVolume(
    targetVolume: number,
    durationMs: number = 180,
    onComplete?: () => void,
  ): void {
    this.cancelFade();
    const startVolume = this.audio.volume;
    const diff = targetVolume - startVolume;
    if (Math.abs(diff) < 0.001 || durationMs <= 0) {
      this.audio.volume = Math.max(0, Math.min(1, targetVolume));
      onComplete?.();
      return;
    }

    const startTime = performance.now();

    const tick = () => {
      const now = performance.now();
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 0.5 - 0.5 * Math.cos(progress * Math.PI);
      const current = startVolume + diff * eased;
      this.audio.volume = Math.max(0, Math.min(1, current));

      if (progress < 1) {
        // audio fade ticks independently of display vsync in background
        this.fadeTimer = setTimeout(tick, 16);
      } else {
        this.fadeTimer = null;
        this.audio.volume = Math.max(0, Math.min(1, targetVolume));
        onComplete?.();
      }
    };

    this.fadeTimer = setTimeout(tick, 16);
  }

  /**
   * Ramps up from silence on a newly started track using the configured
   * transition's fade-in duration (0 = jump straight to the set volume).
   * Tracks are always loaded with `volume = 0`, so this is the incoming half
   * of the transition.
   */
  private applyTransitionFadeIn(): void {
    const { volume, transitionPreset } = usePlayerStore.getState();
    const fadeInMs = transitionSpec(transitionPreset).fadeInMs;
    if (fadeInMs <= 0) {
      this.audio.volume = Math.max(0, Math.min(1, volume));
      return;
    }
    this.fadeVolume(volume, fadeInMs);
  }

  /**
   * Fades the outgoing track to silence before switching to another song.
   * Resolves as soon as the fade completes (or immediately when there is no
   * configured fade-out, nothing playing, or no source loaded), so a manual
   * skip stays instant with the "off" preset.
   */
  private fadeOutForTransition(): Promise<void> {
    const fadeOutMs = transitionSpec(
      usePlayerStore.getState().transitionPreset,
    ).fadeOutMs;
    const audio = this.audio;
    const hasSource = Boolean(audio.src) && audio.src !== window.location.href;
    if (fadeOutMs <= 0 || !hasSource || audio.paused || audio.ended) {
      return Promise.resolve();
    }

    log("cyan", "audio", `transition fade-out (${fadeOutMs}ms)`);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.fadeVolume(0, fadeOutMs, finish);
      // Safety net: never block the switch if the fade tick stalls.
      setTimeout(finish, fadeOutMs + 80);
    });
  }

  /**
   * Starts the outgoing fade-out over the final stretch of the current song,
   * at most once per track. Called from the `timeupdate` handler.
   */
  private maybeStartEndFade(audioEl: HTMLAudioElement): void {
    // An active overlapping crossfade owns the tail; the sequential fade is
    // only the fallback for when no blend could start.
    if (this.crossfade) return;
    const fadeOutMs = transitionSpec(
      usePlayerStore.getState().transitionPreset,
    ).fadeOutMs;
    if (fadeOutMs <= 0 || !this.currentTrackId) return;
    if (this.endFadeTrackId === this.currentTrackId) return;
    if (audioEl.paused) return;

    const duration = audioEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const remainingMs = (duration - audioEl.currentTime) * 1000;
    if (remainingMs <= 0 || remainingMs > fadeOutMs) return;

    this.endFadeTrackId = this.currentTrackId;
    log("cyan", "audio", `end-of-song fade-out (${fadeOutMs}ms)`);
    this.fadeVolume(0, fadeOutMs);
  }

  /**
   * Overlapping-crossfade trigger (the web/Electron counterpart of the
   * Android runtime's blend): once the outgoing song enters the possible
   * blend window, the incoming song starts playing on a second element and
   * both are blended on an equal-power curve, sized to fit both songs.
   */
  private maybeStartCrossfade(audioEl: HTMLAudioElement): void {
    const spec = transitionSpec(usePlayerStore.getState().transitionPreset);
    if (!spec.overlap || this.crossfade) return;
    const duration = audioEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const remainingMs = (duration - audioEl.currentTime) * 1000;
    if (remainingMs <= 0 || remainingMs > CROSSFADE_MAX_MS) return;
    const next = peekAutoNextTrack(usePlayerStore.getState());
    if (!next) return;
    const windowMs = autoCrossfadeWindowMs(remainingMs, next.durationMs);
    if (windowMs <= 0) return;
    void this.startCrossfade(next, windowMs);
  }

  private async startCrossfade(next: Track, windowMs: number): Promise<void> {
    const epoch = ++this.crossfadeEpoch;
    log("cyan", "audio", `crossfade starting into "${next.title}" (${windowMs}ms window)`);
    try {
      const element = this.xAudio ?? this.createCrossfadeElement();
      this.xAudio = element;

      const stream = await resolvePlaybackStream(
        next,
        undefined,
        usePlayerStore.getState().audioQuality,
      );
      if (epoch !== this.crossfadeEpoch) return;
      if (!this.currentTrackId) return;
      if (!stream.url) return;

      const isBlob = stream.url.startsWith("blob:");
      const previousBlob = element.src.startsWith("blob:") ? element.src : null;
      element.src = stream.url;
      (element as HTMLAudioElement & { __linerIsBlob?: boolean }).__linerIsBlob = isBlob;
      element.playbackRate = this.audio.playbackRate;
      element.volume = 0;
      element.load();
      if (previousBlob && previousBlob !== stream.url) URL.revokeObjectURL(previousBlob);

      await element.play();
      if (epoch !== this.crossfadeEpoch) {
        element.pause();
        return;
      }

      // Fit the blend to the time that is actually left now that both songs
      // are audible.
      const remainingNow = (this.audio.duration - this.audio.currentTime) * 1000;
      const window = Math.max(
        1_000,
        Math.min(windowMs, Number.isFinite(remainingNow) && remainingNow > 0 ? remainingNow : windowMs),
      );

      const state = {
        trackId: next.id,
        element,
        windowMs: window,
        startedAt: performance.now(),
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      this.crossfade = state;
      const tick = () => {
        if (this.crossfade !== state) return;
        const t = Math.min(1, (performance.now() - state.startedAt) / state.windowMs);
        const { outgoing, incoming } = equalPowerBlend(t);
        const volume = usePlayerStore.getState().volume;
        this.audio.volume = volume * outgoing;
        state.element.volume = volume * incoming;
        if (t < 1) {
          state.timer = setTimeout(tick, 16);
        } else {
          state.timer = null;
          this.completeCrossfade(state.element, next);
        }
      };
      tick();
    } catch (err) {
      if (epoch === this.crossfadeEpoch) {
        log(
          "yellow",
          "audio",
          `crossfade skipped for "${next.title}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Promotes the incoming element to primary. The old element's listeners
   * guard on `audioEl !== this.audio`, so they go inert by themselves; the
   * parked element is reused as the next crossfade's incoming side.
   */
  private completeCrossfade(element: HTMLAudioElement, next: Track): void {
    if (!this.crossfade || this.crossfade.element !== element) return;
    this.crossfade = null;

    const old = this.audio;
    const oldBlob = this.activeBlobUrl;

    this.audio = element;
    this.audio.id = "liner-audio";
    old.id = "";
    this.attachedTrackId = next.id;
    this.activeBlobUrl = (element as HTMLAudioElement & { __linerIsBlob?: boolean }).__linerIsBlob
      ? element.src
      : null;
    if (typeof window !== "undefined") {
      (window as unknown as { __liner_audio: HTMLAudioElement }).__liner_audio = element;
    }
    this.setupAudioListeners(element);
    this.applyPlaybackRateAndPitch();

    try {
      old.pause();
      old.removeAttribute("src");
      old.load();
    } catch {}
    if (oldBlob && oldBlob !== this.activeBlobUrl) URL.revokeObjectURL(oldBlob);

    this.adoptTrackId = next.id;
    log("green", "audio", `crossfade completed - "${next.title}" promoted`);
    usePlayerStore.getState().dispatch({ type: "SKIP_NEXT", isAutoEnd: true });
  }

  private createCrossfadeElement(): HTMLAudioElement {
    const element = new Audio();
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    return element;
  }

  private cancelCrossfade(): void {
    this.crossfadeEpoch += 1;
    const state = this.crossfade;
    this.crossfade = null;
    if (state?.timer) clearTimeout(state.timer);
    if (state) {
      try {
        state.element.pause();
        state.element.removeAttribute("src");
        state.element.load();
      } catch {}
    }
  }

  private safeResetAudioElement() {
    this.isResetting = true;
    this.currentSessionExpiresAt = null;
    try {
      this.cancelFade();
      this.audio.pause();
      if (this.activeBlobUrl) {
        URL.revokeObjectURL(this.activeBlobUrl);
        this.activeBlobUrl = null;
      }
      this.audio.removeAttribute("src");
      this.audio.load();
      this.attachedTrackId = null;
    } catch {
    } finally {
      this.isResetting = false;
    }
  }

  // between tracks: silence the old source but keep it attached until the next one
  // is ready. Emptying the element here made Chromium drop the system media session
  // during every skip, so Windows controls / FluentFlyout lost Liner after a track change.
  private pauseForTransition() {
    this.isResetting = true;
    this.currentSessionExpiresAt = null;
    try {
      this.cancelFade();
      this.audio.pause();
    } catch {
    } finally {
      this.isResetting = false;
    }
  }

  private attachSource(url: string, isBlob: boolean, trackId: string) {
    const previousBlob = this.activeBlobUrl;
    this.audio.src = url;
    this.activeBlobUrl = isBlob ? url : null;
    this.attachedTrackId = trackId;
    if (previousBlob && previousBlob !== url) URL.revokeObjectURL(previousBlob);
  }

  public cancelPendingLoad(): void {
    this.cancelCrossfade();
    this.loadEpoch += 1;
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    this.backgroundCacheAbortController?.abort();
    this.backgroundCacheAbortController = null;
    this.currentTrackId = null;
    this.currentSessionExpiresAt = null;
    this.recoveryAttempts = 0;
    this.recoveryHoldUntilMs = null;
    this.safeResetAudioElement();
    usePlayerStore.getState().setStatus("paused");
    log("cyan", "playback", "pending load cancelled");
  }

  public async preloadTrack(track: Track): Promise<void> {
    if (this.currentTrackId === track.id) return;
    if (this.preloadingTrackId === track.id) return;

    const cached = await linerDb.getAudio(track.id);
    if (cached) return;

    this.preloadAbortController?.abort();
    const controller = new AbortController();
    this.preloadAbortController = controller;
    this.preloadingTrackId = track.id;

    const generation = audioCache.currentGeneration();
    const promise = (async () => {
      try {
        const stream = await resolvePlaybackStream(
          track,
          controller.signal,
          usePlayerStore.getState().audioQuality,
        );
        if (controller.signal.aborted) return;
        // Warm the in-memory stream cache only; never download/write audio to
        // disk during preload (files are saved only via the Download action).
        if (!AUTO_CACHE_AUDIO) return;

        const blob = await this.downloadAudioBlob(stream, controller.signal);
        if (!blob || controller.signal.aborted) return;
        if (!(await audioCache.saveAudioBlob(track.id, blob, blob.type, generation))) return;
        await linerDb.putTrack(track);
        log(
          "green",
          "preload",
          `preloaded audio: "${track.title}" (${Math.round(blob.size / 1024)} KB)`,
        );
      } catch {
      } finally {
        if (this.preloadingTrackId === track.id) {
          this.preloadingTrackId = null;
          this.preloadingPromise = null;
          this.preloadAbortController = null;
        }
      }
    })();

    this.preloadingPromise = promise;
    await promise;
  }

  private pendingStartPositionMs = 0;

  public stop(): void {
    this.cancelPendingLoad();
    this.updateMediaSessionMetadata(null);
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "none";
      } catch {}
    }
  }

  public setPendingSeek(positionMs: number): void {
    this.pendingStartPositionMs = positionMs;
    usePlayerStore.getState().setPosition(positionMs);
    if (this.audio.src && this.audio.src !== window.location.href) {
      try {
        if (this.audio.readyState >= 1) {
          this.audio.currentTime = positionMs / 1000;
        } else {
          this.audio.addEventListener(
            "loadedmetadata",
            () => {
              try {
                this.audio.currentTime = positionMs / 1000;
              } catch {}
            },
            { once: true },
          );
        }
      } catch {}
    }
  }

  public async loadAndPlay(
    track: Track,
    startPositionMs: number = 0,
    bypassCache: boolean = false,
  ) {
    if (this.adoptTrackId === track.id) {
      // Queue advance after a completed crossfade: the promoted element is
      // already playing this track — adopt it instead of reloading.
      this.adoptTrackId = null;
      if (this.attachedTrackId === track.id && !this.audio.paused && !this.audio.ended) {
        usePlayerStore.getState().setStatus("playing");
        this.updateMediaSessionMetadata(track);
        log("green", "playback", `adopted crossfaded track "${track.title}"`);
        return;
      }
    }
    this.cancelCrossfade();
    this.cancelFade();
    this.pendingStartPositionMs = startPositionMs;
    const epoch = ++this.loadEpoch;

    if (this.currentTrackId !== track.id) {
      this.recoveryAttempts = 0;
      this.recoveryHoldUntilMs = null;
      // Fade the outgoing song out before switching (no-op when the preset's
      // fade-out is 0 or nothing is currently audible).
      await this.fadeOutForTransition();
    }

    if (this.preloadingTrackId === track.id && this.preloadingPromise) {
      await this.preloadingPromise;
    } else if (this.preloadingTrackId && this.preloadingTrackId !== track.id) {
      this.preloadAbortController?.abort();
      this.preloadAbortController = null;
      this.preloadingTrackId = null;
      this.preloadingPromise = null;
    }

    this.loadAbortController?.abort();
    const controller = new AbortController();
    this.loadAbortController = controller;

    this.backgroundCacheAbortController?.abort();
    const bgCacheController = new AbortController();
    this.backgroundCacheAbortController = bgCacheController;

    const store = usePlayerStore.getState();
    if (!store.keepSpeedAcrossTracks && this.currentTrackId !== track.id) {
      store.resetSpeedAndPitch();
    }
    this.currentTrackId = track.id;
    this.endFadeTrackId = null;
    this.loadStartTime = performance.now();
    this.updateMediaSessionMetadata(track);

    store.setStatus("loading", null);
    store.setPosition(startPositionMs > 0 ? startPositionMs : 0);

    this.pauseForTransition();

    try {
      const cachedAudio = bypassCache ? null : await linerDb.getAudio(track.id);
      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        return;
      }

      const isValidCachedBlob =
        Boolean(cachedAudio?.blob) &&
        cachedAudio!.blob.size > 0 &&
        (!cachedAudio!.blob.type || cachedAudio!.blob.type.startsWith("audio/"));

      if (cachedAudio && !isValidCachedBlob) {
        void linerDb.deleteAudio(track.id);
        audioCache.deleteAudio(track.id);
      }

      if (cachedAudio && isValidCachedBlob) {
        this.currentSessionExpiresAt = null;
        void linerDb.putTrack(track);
        const blobUrl = URL.createObjectURL(cachedAudio.blob);
        this.attachSource(blobUrl, true, track.id);
        this.audio.volume = 0;
        this.audio.load();
        this.applyPlaybackRateAndPitch();

        const targetPosition =
          this.pendingStartPositionMs > 0
            ? this.pendingStartPositionMs
            : startPositionMs;
        this.seekWhenReady(epoch, targetPosition);
        log(
          "cyan",
          "playback",
          `audio cache hit for "${track.title}" (${Math.round(cachedAudio.byteSize / 1024)} KB)`,
        );

        if (this.audio.readyState < 3) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 3000);
            const onCanPlay = () => {
              clearTimeout(timeout);
              this.audio.removeEventListener("canplay", onCanPlay);
              this.audio.removeEventListener("error", onCanPlay);
              resolve();
            };
            this.audio.addEventListener("canplay", onCanPlay, { once: true });
            this.audio.addEventListener("error", onCanPlay, { once: true });
          });
        }

        if (epoch !== this.loadEpoch || controller.signal.aborted) return;

        const playPromise = this.audio.play();
        this.activePlayPromise = playPromise;
        await playPromise;

        const audioStartLatencyMs = Math.round(
          performance.now() - this.loadStartTime,
        );

        if (epoch === this.loadEpoch) {
          usePlayerStore.getState().setStatus("playing");
          this.applyTransitionFadeIn();
        }
        log(
          "green",
          "playback",
          `started (cached): ${track.title} in ${audioStartLatencyMs}ms`,
        );
        return;
      }

      const stream = await resolvePlaybackStream(
        track,
        controller.signal,
        usePlayerStore.getState().audioQuality,
      );
      this.ttfbMs = Math.round(performance.now() - this.loadStartTime);

      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        log("yellow", "playback", `superseded before stream ready (${track.title})`);
        return;
      }

      const streamCodec = stream.codec;
      const streamBitrate = stream.bitrate;
      this.currentSessionExpiresAt = stream.expiresAtMs;
      log("cyan", "playback", `resolved stream for ${track.title}`);
      const url = stream.blob ? URL.createObjectURL(stream.blob) : stream.url;
      this.attachSource(url, Boolean(stream.blob), track.id);
      this.audio.volume = 0;
      this.audio.load();
      this.applyPlaybackRateAndPitch();

      const targetPosition =
        this.pendingStartPositionMs > 0
          ? this.pendingStartPositionMs
          : startPositionMs;
      this.seekWhenReady(epoch, targetPosition);
      log(
        "green",
        "playback",
        `stream attached: ${streamCodec} ${streamBitrate} bps (${track.title})`,
      );

      if (this.audio.readyState < 3) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 3000);
          const onCanPlay = () => {
            clearTimeout(timeout);
            this.audio.removeEventListener("canplay", onCanPlay);
            this.audio.removeEventListener("error", onCanPlay);
            resolve();
          };
          this.audio.addEventListener("canplay", onCanPlay, { once: true });
          this.audio.addEventListener("error", onCanPlay, { once: true });
        });
      }

      if (epoch !== this.loadEpoch || controller.signal.aborted) return;

      const playPromise = this.audio.play();
      this.activePlayPromise = playPromise;
      await playPromise;

      const audioStartLatencyMs = Math.round(
        performance.now() - this.loadStartTime,
      );

      if (epoch === this.loadEpoch) {
        usePlayerStore.getState().setStatus("playing");
        this.fadeVolume(usePlayerStore.getState().volume, 180);
        this.cacheAudioInBackground(track, stream, bgCacheController.signal);
        this.applyTransitionFadeIn();
      }
      log(
        "green",
        "playback",
        `started: ${track.title} in ${audioStartLatencyMs}ms`,
      );

      telemetry.trackPlaybackHealth("INIT_LATENCY", {
        trackId: track.id,
        codec: streamCodec,
        bitrate: streamBitrate,
        timeToFirstByteMs: this.ttfbMs,
        audioStartLatencyMs,
      });
    } catch (error) {
      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        return;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      if (error instanceof DOMException && error.name === "NotAllowedError") {
        log("yellow", "playback", "autoplay blocked â€” waiting for user gesture");
        usePlayerStore.getState().setStatus("paused");
        return;
      }

      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Playback failed to start.";
      console.error("[LoadAndPlayError]", track.id, error);
      log("red", "playback", `failed: ${message}`);
      usePlayerStore.getState().setStatus("error", message);

      telemetry
        .reportError(error, {
          action: "playback_failed",
          trackId: track.id,
          title: track.title,
        })
        .catch(() => {});

      this.onError?.({ trackId: track.id, message });
    } finally {
      if (epoch === this.loadEpoch) {
        this.activePlayPromise = null;
      }
    }
  }

  private seekWhenReady(epoch: number, positionMs: number) {
    if (positionMs <= 0) return;
    const apply = () => {
      if (epoch !== this.loadEpoch) return;
      try {
        this.audio.currentTime = positionMs / 1000;
      } catch {
        // Media not seekable yet â€” ignore
      }
    };
    if (this.audio.readyState >= 1) {
      apply();
    } else {
      this.audio.addEventListener("loadedmetadata", apply, { once: true });
    }
  }

  public pause() {
    this.cancelCrossfade();
    const epoch = ++this.loadEpoch;
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    usePlayerStore.getState().setStatus("paused");
    log("cyan", "audio", "pause requested (fading out)");

    this.fadeVolume(0, 180, () => {
      if (epoch !== this.loadEpoch) return;
      this.audio.pause();
    });
  }

  public resume() {
    const epoch = ++this.loadEpoch;
    this.loadAbortController?.abort();
    this.loadAbortController = null;

    const targetVolume = usePlayerStore.getState().volume;
    usePlayerStore.getState().setStatus("playing");
    pitchShifter.resumeContext();
    this.applyPlaybackRateAndPitch();
    log("cyan", "audio", "resume requested (fading in)");

    const currentTrack = usePlayerStore.getState().currentTrack;
    const isExpired =
      this.currentSessionExpiresAt !== null &&
      Date.now() >= this.currentSessionExpiresAt - 15_000;
    const hasMediaError = Boolean(this.audio.error);
    const hasValidSource =
      Boolean(this.audio.src) &&
      this.audio.src !== window.location.href &&
      !isExpired &&
      !hasMediaError;

    if (!hasValidSource && currentTrack) {
      void this.loadAndPlay(
        currentTrack,
        usePlayerStore.getState().positionMs,
      );
      return;
    }

    if (this.audio.paused) {
      this.audio.volume = 0;
      const playPromise = this.audio.play();
      this.activePlayPromise = playPromise;
      playPromise
        .then(() => {
          if (epoch !== this.loadEpoch) return;
          this.fadeVolume(targetVolume, 180);
        })
        .catch((error) => {
          if (epoch !== this.loadEpoch) return;
          if (error.name === "NotAllowedError") {
            log("yellow", "audio", "play blocked â€” waiting for user gesture");
            usePlayerStore.getState().setStatus("paused");
          } else if (error.name !== "AbortError") {
            log("red", "audio", `play failed: ${String(error)}`);
            if (currentTrack && this.recoveryAttempts < 1) {
              this.recoveryAttempts++;
              log("yellow", "playback", "resume failed â€” attempting cache/stream recovery");
              void this.loadAndPlay(currentTrack, usePlayerStore.getState().positionMs, true);
              return;
            }
            usePlayerStore.getState().setStatus("paused");
          }
        })
        .finally(() => {
          if (epoch === this.loadEpoch) this.activePlayPromise = null;
        });
    } else {
      this.fadeVolume(targetVolume, 180);
    }
  }

  /** (Re)arms the JS-side sleep timer; a null/elapsed deadline cancels it. */
  private syncSleepTimer(endsAtMs: number | null): void {
    if (this.sleepTimerId !== null) {
      clearTimeout(this.sleepTimerId);
      this.sleepTimerId = null;
    }
    if (!endsAtMs) return;
    const delay = Math.max(0, endsAtMs - Date.now());
    this.sleepTimerId = setTimeout(() => this.fireSleepTimer(), delay);
  }

  /** Fades out, pauses, and clears the sleep timer when the deadline hits. */
  private fireSleepTimer(): void {
    this.sleepTimerId = null;
    if (usePlayerStore.getState().status !== "playing") {
      usePlayerStore.getState().setSleepTimer(null);
      return;
    }
    log("cyan", "audio", "sleep timer ended â€” fading out and pausing");
    this.fadeVolume(0, 4_000, () => {
      this.audio.pause();
      this.audio.volume = Math.max(
        0,
        Math.min(1, usePlayerStore.getState().volume),
      );
      usePlayerStore.getState().setStatus("paused");
      usePlayerStore.getState().setSleepTimer(null);
    });
  }

  public seek(positionMs: number) {
    if (!this.audio.src || this.audio.src === window.location.href) return;
    // A seek moves away from the blend window: end an active crossfade early
    // and snap the primary back to the user volume.
    if (this.crossfade) {
      this.cancelCrossfade();
      if (!this.audio.paused) {
        this.audio.volume = usePlayerStore.getState().volume;
      }
    }
    // Seeking away from the tail cancels an in-progress end-of-song fade so
    // the track isn't left muted; timeupdate restarts it if we land back in
    // the fade-out window.
    if (this.endFadeTrackId !== null) {
      this.endFadeTrackId = null;
      this.cancelFade();
      if (!this.audio.paused) {
        this.audio.volume = Math.max(
          0,
          Math.min(1, usePlayerStore.getState().volume),
        );
      }
    }
    try {
      if (this.audio.readyState >= 1) {
        this.audio.currentTime = positionMs / 1000;
      } else {
        this.audio.addEventListener(
          "loadedmetadata",
          () => {
            try {
              this.audio.currentTime = positionMs / 1000;
            } catch {}
          },
          { once: true },
        );
      }
    } catch {
      // Ignore seek error if media not yet ready
    }
  }

  private async downloadAudioBlob(stream: PlaybackStream, signal: AbortSignal): Promise<Blob | null> {
    if (stream.blob) return stream.blob;
    const startedAt = performance.now();
    const bytes = await downloadAudioBytes(stream.url, {
      contentLength: stream.contentLength,
      signal,
    });
    if (!bytes || signal.aborted) return null;
    const mimeType = stream.mimeType || "audio/webm";
    if (!mimeType.startsWith("audio/") && !mimeType.startsWith("video/")) return null;
    if (!isStandaloneAudioFile(bytes.subarray(0, 16))) {
      log("yellow", "download", `not caching: stream is not a standalone audio file`);
      return null;
    }
    log(
      "cyan",
      "download",
      `${Math.round(bytes.byteLength / 1024)} KB in ${Math.round(performance.now() - startedAt)}ms (${stream.contentLength ? "chunked" : "single request"})`,
    );
    return new Blob([bytes], { type: mimeType });
  }

  private cacheAudioInBackground(track: Track, stream: PlaybackStream, signal: AbortSignal) {
    if (!AUTO_CACHE_AUDIO) return;
    if (track.durationMs && track.durationMs > 20 * 60 * 1000) return;
    const generation = audioCache.currentGeneration();
    void (async () => {
      try {
        const blob = await this.downloadAudioBlob(stream, signal);
        if (!blob || signal.aborted) return;
        if (!(await audioCache.saveAudioBlob(track.id, blob, blob.type, generation))) return;
        await linerDb.putTrack(track);
        log("green", "playback", `background cached: ${track.title} (${Math.round(blob.size / 1024)} KB)`);
      } catch {}
    })();
  }
}

// Singleton used by tests and any desktop-only code path. On Android the
// AndroidPlayerRuntime (native Media3 service) is the only audio engine, so no
// second HTMLAudioElement engine is created here.
export const playerRuntime =
  typeof window !== "undefined" && !(window as { LinerAndroid?: unknown }).LinerAndroid
    ? new PlayerRuntime()
    : null;
