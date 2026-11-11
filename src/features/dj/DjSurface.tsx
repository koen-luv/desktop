import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayerStore } from "@/features/player";
import Waveform from "./WaveformView";
import Knob from "./Knob";
import MidiPanel from "./midi/MidiPanel";
import { useMidi } from "./midi/useMidi";
import type { DjAction } from "./midi/midiMap";
import { analyzeTrack, type TrackAnalysis } from "./analysis";
import { fadeProgress, planTransition, type TransitionPlan } from "./transition";
import { resolvePlaybackStream } from "@/features/player/engine/playbackSource";
import type { Track } from "@/shared/types";
import { log } from "@/shared/utils/logger";
import {
  crossfadeGains,
  deckGain,
  formatDeckTime,
  needsResync,
  tempoToRate,
} from "./mixMath";
import { createDeckChain, NEUTRAL_EQ, type EqBand } from "./deckAudio";
import { createDeckFx, NEUTRAL_FX, type FxState } from "./fx";
import { computePeaks, toMono, type WaveformPeaks } from "./waveform";
import { loopedPosition, makeLoop, tapTempo } from "./loopMath";
import { quantizePosition } from "./bpm";
import "./dj.css";

/**
 * DJ mode — "The Booth".
 *
 * The surface mirrors the object it imitates: two decks flanking a metal mixer
 * column, with a full-width chroma-coded waveform ribbon on top (teal deck A,
 * magenta deck B, amber playhead). Transport and pads live on the decks the way
 * they do on a CDJ; trim, EQ, filter and FX sit on the channel strips the way
 * they do on a mixer. Colour is state — amber for cued/armed, green for
 * playing — never decoration.
 *
 * It owns its own decks so a mix cannot fight the queue, and closes cleanly.
 */

interface DeckState {
  track: Track | null;
  /** Stream URL the deck is playing; the ribbon decodes this. */
  src: string | null;
  playing: boolean;
  loading: boolean;
  trim: number;
  tempo: number; // -0.08 … 0.08
  positionMs: number;
  durationMs: number;
  error: string | null;
  eq: EqBand;
  loop: { startMs: number; lengthMs: number } | null;
  hotcues: (number | null)[];
  bpm: number | null;
  anchorMs: number;
  fx: FxState;
  peaks: WaveformPeaks | null;
  peaksStatus: "idle" | "ready" | "unavailable";
  analysis: TrackAnalysis | null;
}

const EMPTY_DECK: DeckState = {
  track: null,
  src: null,
  playing: false,
  loading: false,
  trim: 1,
  tempo: 0,
  positionMs: 0,
  durationMs: 0,
  error: null,
  eq: NEUTRAL_EQ,
  loop: null,
  hotcues: [null, null, null, null],
  bpm: null,
  anchorMs: 0,
  fx: NEUTRAL_FX,
  peaks: null,
  peaksStatus: "idle",
  analysis: null,
};

const SIDE_LABEL = { a: "A", b: "B" } as const;

/* ── Deck: what a CDJ carries — transport, pads, loops, tempo ─────────────── */

function DeckPanel({
  side,
  state,
  focused,
  canSync,
  cueMode,
  onFocus,
  onPlay,
  onPause,
  onCue,
  onSync,
  onNudge,
  onSeek,
  onTempo,
  onLoop,
  onExitLoop,
  onHotcueSet,
  onHotcueClear,
  onHotcueGo,
  onTap,
  onToggleCueMode,
}: {
  side: "a" | "b";
  state: DeckState;
  focused: boolean;
  canSync: boolean;
  cueMode: boolean;
  onFocus: () => void;
  onPlay: () => void;
  onPause: () => void;
  onCue: () => void;
  onSync: () => void;
  onNudge: (deltaMs: number) => void;
  onSeek: (ms: number) => void;
  onTempo: (value: number) => void;
  onLoop: (beats: number) => void;
  onExitLoop: () => void;
  onHotcueSet: (index: number) => void;
  onHotcueClear: (index: number) => void;
  onHotcueGo: (index: number) => void;
  onTap: () => void;
  onToggleCueMode: () => void;
}) {
  const isA = side === "a";
  const hueClass = isA ? "dj-deck-a" : "dj-deck-b";
  const padSet = isA ? "dj-pad--set" : "dj-pad--set dj-pad-b";
  const loopBeats: Array<{ beats: number; label: string }> = [
    { beats: 0.5, label: "½" },
    { beats: 1, label: "1" },
    { beats: 2, label: "2" },
    { beats: 4, label: "4" },
    { beats: 8, label: "8" },
  ];

  return (
    <section
      onClick={onFocus}
      aria-label={`Deck ${SIDE_LABEL[side]}`}
      className={`dj-panel flex min-w-0 flex-1 flex-col gap-2 p-3 transition-colors ${
        focused ? "border-t-2" : "border-t-2 border-t-transparent"
      }`}
      style={focused ? { borderTopColor: isA ? "var(--dj-deck-a)" : "var(--dj-deck-b)" } : undefined}
    >
      {/* identity + state LED */}
      <div className="flex items-center gap-2">
        <span className={`dj-deck-letter ${hueClass}`}>{SIDE_LABEL[side]}</span>
        <span
          aria-hidden="true"
          className={`dj-led ${
            state.playing ? "dj-led--on-green" : state.track ? "dj-led--on-amber" : ""
          }`}
        />
        <span className="dj-value truncate">
          {state.bpm ? `${state.bpm.toFixed(1)} BPM` : "— — —"}
        </span>
      </div>

      <div className="min-h-[34px]">
        <p className="m-0 truncate text-[13px] font-[600] text-text-primary">
          {state.track ? state.track.title : "Empty deck"}
        </p>
        <p className="m-0 truncate text-[11px] text-text-tertiary">
          {state.track ? state.track.artists : "Load from the library"}
        </p>
      </div>

      {state.error ? <p className="m-0 text-[11px] text-red-400">{state.error}</p> : null}

      {/* time readout */}
      <div className="flex items-baseline justify-between">
        <span className={`dj-value dj-value--big ${hueClass}`}>
          {formatDeckTime(state.positionMs)}
        </span>
        <span className="dj-value">
          −{formatDeckTime(Math.max(0, state.durationMs - state.positionMs))}
        </span>
      </div>

      {/* transport */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCue}
          disabled={!state.track}
          className="dj-btn dj-btn--amber"
        >
          Cue
        </button>
        <button
          type="button"
          onClick={state.playing ? onPause : onPlay}
          disabled={!state.track || state.loading}
          className={`dj-btn flex-1 ${state.playing ? "dj-btn--green" : ""}`}
        >
          {state.loading ? "…" : state.playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={onSync}
          disabled={!canSync}
          className={`dj-btn ${Math.abs(state.tempo) > 0.001 ? "dj-btn--lit" : ""}`}
        >
          Sync
        </button>
      </div>

      {/* nudges */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onNudge(-500)}
          disabled={!state.track}
          aria-label={`Deck ${SIDE_LABEL[side]} back half second`}
          className="dj-btn flex-1"
        >
          ◄ Nudge
        </button>
        <button
          type="button"
          onClick={() => onNudge(500)}
          disabled={!state.track}
          aria-label={`Deck ${SIDE_LABEL[side]} forward half second`}
          className="dj-btn flex-1"
        >
          Nudge ►
        </button>
      </div>

      {/* loops */}
      <div className="flex items-center gap-1">
        <span className="dj-label w-[26px]">Loop</span>
        {loopBeats.map(({ beats, label }) => {
          const active =
            state.loop !== null &&
            state.bpm !== null &&
            Math.abs(state.loop.lengthMs - (60_000 / state.bpm) * beats) < 1;
          return (
            <button
              key={beats}
              type="button"
              onClick={() => onLoop(beats)}
              disabled={!state.track}
              aria-label={`Deck ${SIDE_LABEL[side]} loop ${label}`}
              className={`dj-btn h-[24px] w-[28px] p-0 ${active ? "dj-btn--amber" : ""}`}
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onExitLoop}
          disabled={!state.loop}
          className="dj-btn h-[24px] flex-1 p-0"
        >
          Exit
        </button>
      </div>

      {/* hot cue pads */}
      <div className="flex items-center gap-1">
        <span className="dj-label w-[26px]">Cue</span>
        {state.hotcues.map((cue, index) => (
          <button
            key={index}
            type="button"
            onClick={() =>
              cueMode ? onHotcueSet(index) : cue !== null ? onHotcueGo(index) : onHotcueSet(index)
            }
            onContextMenu={(event) => {
              event.preventDefault();
              onHotcueClear(index);
            }}
            disabled={!state.track}
            aria-label={`Hotcue ${index + 1}${cue !== null ? " set" : ""}`}
            className={`dj-pad ${cue !== null ? padSet : ""} ${cueMode ? "dj-pad--arm" : ""}`}
          >
            {index + 1}
          </button>
        ))}
        <button
          type="button"
          onClick={onToggleCueMode}
          aria-pressed={cueMode}
          className={`dj-btn h-[26px] flex-1 p-0 ${cueMode ? "dj-btn--lit" : ""}`}
        >
          {cueMode ? "Arming" : "Set"}
        </button>
      </div>

      {/* tempo fader (CDJ pitch slider) */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="dj-label">Tempo</span>
          <span className={`dj-value ${Math.abs(state.tempo) > 0.001 ? hueClass : ""}`}>
            {(state.tempo * 100).toFixed(1)}%
          </span>
        </div>
        <input
          type="range"
          aria-label={`Deck ${SIDE_LABEL[side]} tempo`}
          min={-0.08}
          max={0.08}
          step={0.005}
          value={state.tempo}
          onChange={(event) => onTempo(Number(event.target.value))}
          className="w-full accent-accent-primary"
        />
      </div>

      <button
        type="button"
        onClick={onTap}
        disabled={!state.track}
        className="dj-btn w-full"
      >
        Tap
      </button>
    </section>
  );
}

/* ── Channel strip: what a mixer carries — trim → EQ → filter → FX ────────── */

function ChannelStrip({
  side,
  state,
  onEq,
  onFx,
  onTrim,
}: {
  side: "a" | "b";
  state: DeckState;
  onEq: (band: keyof EqBand, value: number) => void;
  onFx: (key: keyof FxState, value: number) => void;
  onTrim: (value: number) => void;
}) {
  const hueClass = side === "a" ? "dj-deck-a" : "dj-deck-b";
  return (
    <div className="flex flex-1 flex-col items-center gap-1.5">
      <span className={`dj-deck-letter ${hueClass}`}>{SIDE_LABEL[side]}</span>
      <Knob
        label="Trim"
        min={0}
        max={1}
        step={0.01}
        defaultValue={1}
        value={state.trim}
        size={30}
        format={(v) => `${Math.round(v * 100)}`}
        onChange={onTrim}
      />
      {/* hardware order top to bottom: high, mid, low */}
      <Knob
        label="High"
        min={-24}
        max={12}
        step={1}
        defaultValue={0}
        value={state.eq.high}
        size={30}
        format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}`}
        onChange={(next) => onEq("high", next)}
      />
      <Knob
        label="Mid"
        min={-24}
        max={12}
        step={1}
        defaultValue={0}
        value={state.eq.mid}
        size={30}
        format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}`}
        onChange={(next) => onEq("mid", next)}
      />
      <Knob
        label="Low"
        min={-24}
        max={12}
        step={1}
        defaultValue={0}
        value={state.eq.low}
        size={30}
        format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}`}
        onChange={(next) => onEq("low", next)}
      />
      <div className="my-0.5 h-px w-[26px]" style={{ background: "var(--dj-line-strong)" }} />
      <Knob
        label="Filt"
        min={0}
        max={1}
        step={0.01}
        defaultValue={0.5}
        value={state.fx.filter}
        size={30}
        format={(v) => `${Math.round(v * 100)}`}
        onChange={(next) => onFx("filter", next)}
      />
      <Knob
        label="Echo"
        min={0}
        max={1}
        step={0.01}
        defaultValue={0}
        value={state.fx.echo}
        size={30}
        format={(v) => `${Math.round(v * 100)}`}
        onChange={(next) => onFx("echo", next)}
      />
      <Knob
        label="Verb"
        min={0}
        max={1}
        step={0.01}
        defaultValue={0}
        value={state.fx.reverb}
        size={30}
        format={(v) => `${Math.round(v * 100)}`}
        onChange={(next) => onFx("reverb", next)}
      />
    </div>
  );
}

/* ── Surface ──────────────────────────────────────────────────────────────── */

function DjSurface({ onClose }: { onClose: () => void }) {
  const queue = usePlayerStore((state) => state.queue);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const [decks, setDecks] = useState<{ a: DeckState; b: DeckState }>({
    a: EMPTY_DECK,
    b: EMPTY_DECK,
  });
  const [crossfader, setCrossfader] = useState(0.5);
  const [master, setMaster] = useState(1);
  const [focused, setFocused] = useState<"a" | "b">("a");
  const [query, setQuery] = useState("");
  const [cueMode, setCueMode] = useState<"a" | "b" | null>(null);
  const [quantise, setQuantise] = useState(true);
  const [midiOpen, setMidiOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [autoPlan, setAutoPlan] = useState<TransitionPlan | null>(null);
  const [autoArmed, setAutoArmed] = useState(false);
  const masterGainRef = useRef<GainNode | null>(null);
  const audioRef = useRef<{ a: HTMLAudioElement | null; b: HTMLAudioElement | null }>({
    a: null,
    b: null,
  });
  const gainsRef = useRef<{
    ctx: AudioContext;
    a: GainNode;
    b: GainNode;
    eq: { a: ReturnType<typeof createDeckChain>; b: ReturnType<typeof createDeckChain> };
    fx: { a: ReturnType<typeof createDeckFx>; b: ReturnType<typeof createDeckFx> };
  } | null>(null);

  const crossfade = useMemo(() => crossfadeGains(crossfader), [crossfader]);

  const ensureGraph = useCallback(() => {
    if (gainsRef.current) return gainsRef.current;
    const ctx = new AudioContext();
    const a = audioRef.current.a;
    const b = audioRef.current.b;
    if (!a || !b) return null;
    const gainA = ctx.createGain();
    const gainB = ctx.createGain();
    const masterGain = ctx.createGain();
    masterGain.gain.value = master;
    masterGain.connect(ctx.destination);
    // source → 3-band EQ → FX send → trim/crossfade gain → master
    const eqA = createDeckChain(ctx, ctx.createMediaElementSource(a));
    const eqB = createDeckChain(ctx, ctx.createMediaElementSource(b));
    const fxA = createDeckFx(ctx);
    const fxB = createDeckFx(ctx);
    eqA.output.connect(fxA.input);
    fxA.output.connect(gainA).connect(masterGain);
    eqB.output.connect(fxB.input);
    fxB.output.connect(gainB).connect(masterGain);
    masterGainRef.current = masterGain;
    gainsRef.current = { ctx, a: gainA, b: gainB, eq: { a: eqA, b: eqB }, fx: { a: fxA, b: fxB } };
    return gainsRef.current;
  }, []);

  // Apply fader + trim + master + eq + fx continuously.
  useEffect(() => {
    const graph = ensureGraph();
    if (!graph) return;
    graph.a.gain.value = deckGain(crossfade, "a", decks.a.trim);
    graph.b.gain.value = deckGain(crossfade, "b", decks.b.trim);
    if (masterGainRef.current) masterGainRef.current.gain.value = master;
    graph.eq.a.setEq(decks.a.eq);
    graph.eq.b.setEq(decks.b.eq);
    graph.fx.a.update(decks.a.fx, decks.a.bpm ?? 120);
    graph.fx.b.update(decks.b.fx, decks.b.bpm ?? 120);
  }, [
    crossfade,
    decks.a.trim,
    decks.b.trim,
    decks.a.eq,
    decks.b.eq,
    decks.a.fx,
    decks.b.fx,
    decks.a.bpm,
    decks.b.bpm,
    master,
    ensureGraph,
  ]);

  // Transport clocks.
  useEffect(() => {
    const id = window.setInterval(() => {
      const a = audioRef.current.a;
      const b = audioRef.current.b;
      if (!a || !b) return;
      const clock = a.paused ? b.currentTime * 1000 : a.currentTime * 1000;
      setDecks((prev) => ({
        a: { ...prev.a, positionMs: a.currentTime * 1000, durationMs: (a.duration || 0) * 1000 },
        b: { ...prev.b, positionMs: b.currentTime * 1000, durationMs: (b.duration || 0) * 1000 },
      }));
      // Keep the quieter deck phase-locked to the master clock.
      if (!a.paused && !b.paused && needsResync(clock, b.currentTime * 1000)) {
        b.currentTime = clock / 1000;
      }
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Beat loops: wrap each deck back to its loop start when the end passes.
  const loopsRef = useRef<{ a: DeckState["loop"]; b: DeckState["loop"] }>({ a: null, b: null });
  useEffect(() => {
    loopsRef.current = { a: decks.a.loop, b: decks.b.loop };
  }, [decks.a.loop, decks.b.loop]);
  useEffect(() => {
    const id = window.setInterval(() => {
      for (const side of ["a", "b"] as const) {
        const element = audioRef.current[side];
        const loop = loopsRef.current[side];
        if (!element || !loop || element.paused) continue;
        const wrapped = loopedPosition(element.currentTime * 1000, loop);
        if (Math.abs(wrapped - element.currentTime * 1000) > 1) {
          element.currentTime = wrapped / 1000;
        }
      }
    }, 60);
    return () => window.clearInterval(id);
  }, []);

  /** Decode the loaded stream once; waveform, beatgrid and structure all
   * come from this single analysis pass. */
  const analyseTrack = useCallback(async (side: "a" | "b", url: string | null) => {
    if (!url) {
      setDecks((prev) => ({ ...prev, [side]: { ...prev[side], peaksStatus: "unavailable" } }));
      return;
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(bytes);
      const sampleRate = ctx.sampleRate;
      void ctx.close().catch(() => undefined);
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
        buffer.getChannelData(i),
      );
      const mono = new Float32Array(buffer.length);
      for (let i = 0; i < buffer.length; i += 1) {
        let sum = 0;
        let peak = 0;
        for (const channel of channels) {
          const v = channel[i] ?? 0;
          sum += v;
          if (Math.abs(v) > Math.abs(peak)) peak = v;
        }
        mono[i] = Math.abs(sum / channels.length) > Math.abs(peak) ? sum / channels.length : peak;
      }
      const analysis = analyzeTrack(mono, sampleRate);
      setDecks((prev) => ({
        ...prev,
        [side]: {
          ...prev[side],
          peaks: analysis.peaks,
          peaksStatus: "ready",
          analysis,
          // tap tempo always wins over detection
          bpm: prev[side].bpm ?? analysis.bpm,
          anchorMs: analysis.anchorMs,
        },
      }));
    } catch {
      setDecks((prev) => ({ ...prev, [side]: { ...prev[side], peaksStatus: "unavailable" } }));
    }
  }, []);

  const loadTrack = useCallback(
    async (side: "a" | "b", track: Track | undefined) => {
      if (!track) return;
      setDecks((prev) => ({ ...prev, [side]: { ...prev[side], loading: true, error: null } }));
      try {
        const stream = await resolvePlaybackStream(track);
        const element = audioRef.current[side];
        if (!element || !stream.url) throw new Error("No stream available");
        element.src = stream.url;
        element.load();
        setDecks((prev) => ({
          ...prev,
          [side]: {
            ...prev[side],
            track,
            src: stream.url ?? null,
            loading: false,
            durationMs: 0,
            positionMs: 0,
            loop: null,
            hotcues: [null, null, null, null],
            bpm: null,
            anchorMs: 0,
            fx: NEUTRAL_FX,
            peaks: null,
            peaksStatus: "idle",
            analysis: null,
          },
        }));
        void analyseTrack(side, stream.url ?? null);
      } catch (error) {
        log("red", "dj", `deck ${side} could not load "${track.title}"`);
        setDecks((prev) => ({
          ...prev,
          [side]: {
            ...prev[side],
            loading: false,
            error: error instanceof Error ? error.message : "Could not load this track",
          },
        }));
      }
    },
    [analyseTrack],
  );

  const toggle = useCallback(
    async (side: "a" | "b") => {
      const element = audioRef.current[side];
      if (!element) return;
      const graph = ensureGraph();
      if (graph?.ctx.state === "suspended") await graph.ctx.resume();
      if (element.paused) {
        await element.play().catch(() => undefined);
        setDecks((prev) => ({ ...prev, [side]: { ...prev[side], playing: true } }));
      } else {
        element.pause();
        setDecks((prev) => ({ ...prev, [side]: { ...prev[side], playing: false } }));
      }
    },
    [ensureGraph],
  );

  const cue = useCallback((side: "a" | "b") => {
    const element = audioRef.current[side];
    if (!element) return;
    element.pause();
    element.currentTime = 0;
    setDecks((prev) => ({ ...prev, [side]: { ...prev[side], playing: false, positionMs: 0 } }));
  }, []);

  /** Matches the other deck's tempo so the two can be beat-mixed by ear. */
  const syncTempo = useCallback(
    (side: "a" | "b") => {
      const other = side === "a" ? "b" : "a";
      const tempo = decks[other].tempo;
      setDecks((prev) => ({ ...prev, [side]: { ...prev[side], tempo } }));
      const element = audioRef.current[side];
      if (element) element.playbackRate = tempoToRate(tempo);
    },
    [decks],
  );

  const nudge = useCallback((side: "a" | "b", deltaMs: number) => {
    const element = audioRef.current[side];
    if (!element) return;
    element.currentTime = Math.max(0, element.currentTime + deltaMs / 1000);
  }, []);

  const setTempo = useCallback((side: "a" | "b", value: number) => {
    setDecks((prev) => ({ ...prev, [side]: { ...prev[side], tempo: value } }));
    const element = audioRef.current[side];
    if (element) element.playbackRate = tempoToRate(value);
  }, []);

  const setFx = useCallback((side: "a" | "b", key: keyof FxState, value: number) => {
    setDecks((prev) => ({
      ...prev,
      [side]: { ...prev[side], fx: { ...prev[side].fx, [key]: value } },
    }));
  }, []);

  const setEq = useCallback((side: "a" | "b", band: keyof EqBand, value: number) => {
    setDecks((prev) => ({ ...prev, [side]: { ...prev[side], eq: { ...prev[side].eq, [band]: value } } }));
  }, []);

  const setLoop = useCallback(
    (side: "a" | "b", beats: number) => {
      const element = audioRef.current[side];
      if (!element) return;
      setDecks((prev) => {
        const deck = prev[side];
        const bpm = deck.bpm ?? 120;
        const start =
          quantise && deck.bpm
            ? quantizePosition(deck.positionMs, deck.bpm, deck.anchorMs)
            : deck.positionMs;
        const loop = makeLoop(start, beats, bpm);
        return { ...prev, [side]: { ...deck, loop } };
      });
      if (element.paused) void element.play().catch(() => undefined);
    },
    [quantise],
  );

  const exitLoop = useCallback((side: "a" | "b") => {
    setDecks((prev) => ({ ...prev, [side]: { ...prev[side], loop: null } }));
  }, []);

  const setHotcue = useCallback(
    (side: "a" | "b", index: number) => {
      setDecks((prev) => {
        const deck = prev[side];
        const hotcues = [...deck.hotcues];
        hotcues[index] =
          quantise && deck.bpm
            ? quantizePosition(deck.positionMs, deck.bpm, deck.anchorMs)
            : deck.positionMs;
        return { ...prev, [side]: { ...deck, hotcues } };
      });
    },
    [quantise],
  );

  const clearHotcue = useCallback((side: "a" | "b", index: number) => {
    setDecks((prev) => {
      const deck = prev[side];
      const hotcues = [...deck.hotcues];
      hotcues[index] = null;
      return { ...prev, [side]: { ...deck, hotcues } };
    });
  }, []);

  const goToHotcue = useCallback(
    (side: "a" | "b", index: number) => {
      const element = audioRef.current[side];
      const cuePoint = decks[side].hotcues[index];
      if (!element || cuePoint === null || cuePoint === undefined) return;
      element.currentTime = cuePoint / 1000;
    },
    [decks],
  );

  const tapsRef = useRef<{ a: number[]; b: number[] }>({ a: [], b: [] });
  const tap = useCallback((side: "a" | "b") => {
    const now = performance.now();
    const taps = tapsRef.current[side];
    // A gap longer than 2 s restarts the measurement window.
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    const bpm = tapTempo(taps);
    if (bpm) setDecks((prev) => ({ ...prev, [side]: { ...prev[side], bpm } }));
  }, []);

  const close = useCallback(() => {
    for (const side of ["a", "b"] as const) {
      const element = audioRef.current[side];
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
    }
    gainsRef.current?.eq.a.dispose();
    gainsRef.current?.eq.b.dispose();
    gainsRef.current?.fx.a.dispose();
    gainsRef.current?.fx.b.dispose();
    void gainsRef.current?.ctx.close().catch(() => undefined);
    gainsRef.current = null;
    onClose();
  }, [onClose]);

  // Auto-mix: analysis-driven transition between the two decks.
  const autoRef = useRef<{ phase: "ramp"; startedAt: number; from: number } | null>(null);
  const crossfaderRef = useRef(crossfader);
  crossfaderRef.current = crossfader;

  const computedPlan = useMemo(() => {
    const a = decks.a.analysis;
    const b = decks.b.analysis;
    if (!a || !b || !decks.a.track || !decks.b.track) return null;
    return planTransition(a, b, { currentTempoA: decks.a.tempo });
  }, [decks.a.analysis, decks.b.analysis, decks.a.track, decks.b.track, decks.a.tempo]);

  useEffect(() => {
    if (!autoArmed || !autoPlan) return;
    const id = window.setInterval(() => {
      const a = audioRef.current.a;
      const b = audioRef.current.b;
      if (!a || !b) return;
      const phase = autoRef.current;
      if (!phase) {
        if (a.currentTime * 1000 >= autoPlan.triggerAtMs) {
          b.playbackRate = tempoToRate(autoPlan.tempoMatch);
          b.currentTime = Math.max(0, (autoPlan.bStartMs + autoPlan.beatAlignMs) / 1000);
          void b.play().catch(() => undefined);
          setDecks((prev) => ({
            ...prev,
            b: { ...prev.b, playing: true, tempo: autoPlan.tempoMatch },
          }));
          autoRef.current = {
            phase: "ramp",
            startedAt: performance.now(),
            from: crossfaderRef.current,
          };
          log("green", "dj", `auto-mix started: fade ${Math.round(autoPlan.crossfadeMs / 1000)}s`);
        }
        return;
      }
      const t = (performance.now() - phase.startedAt) / autoPlan.crossfadeMs;
      setCrossfader(phase.from + (1 - phase.from) * fadeProgress(t, 1));
      if (t >= 1) {
        a.pause();
        setDecks((prev) => ({ ...prev, a: { ...prev.a, playing: false } }));
        autoRef.current = null;
        setAutoArmed(false);
        log("green", "dj", "auto-mix complete - deck A stopped");
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [autoArmed, autoPlan]);

  // MIDI action bus: one dispatcher for every assignable control.
  const applyMidiAction = useCallback(
    (action: DjAction) => {
      switch (action.kind) {
        case "selectDeck":
          setFocused(action.deck);
          break;
        case "togglePlay":
          void toggle(action.deck);
          break;
        case "cue":
          cue(action.deck);
          break;
        case "sync":
          syncTempo(action.deck);
          break;
        case "loopBeats":
          setLoop(action.deck, action.beats);
          break;
        case "exitLoop":
          exitLoop(action.deck);
          break;
        case "hotcueSet":
          setHotcue(action.deck, action.index);
          break;
        case "hotcueGo":
          goToHotcue(action.deck, action.index);
          break;
        case "hotcueClear":
          clearHotcue(action.deck, action.index);
          break;
        case "eq":
          setEq(action.deck, action.band, action.value);
          break;
        case "fx":
          setFx(action.deck, action.key, action.value);
          break;
        case "trim":
          setDecks((prev) => ({
            ...prev,
            [action.deck]: { ...prev[action.deck], trim: action.value },
          }));
          break;
        case "tempo":
          setTempo(action.deck, action.value);
          break;
        case "crossfader":
          setCrossfader(action.value);
          break;
        case "master":
          setMaster(action.value);
          break;
        case "quantise":
          setQuantise((prev) => !prev);
          break;
      }
    },
    [
      toggle,
      cue,
      syncTempo,
      setLoop,
      exitLoop,
      setHotcue,
      goToHotcue,
      clearHotcue,
      setEq,
      setFx,
      setTempo,
    ],
  );

  const midi = useMidi({ focused, onAction: applyMidiAction });

  // Library: search the queue and load into the focused deck.
  const library = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? queue.filter(
          (track) =>
            track.title.toLowerCase().includes(needle) ||
            (track.artists ?? "").toLowerCase().includes(needle),
        )
      : queue;
    return matches.slice(0, 60);
  }, [queue, query]);

  // Seed both decks from the current queue on open.
  const suggestions = useMemo(() => {
    if (queue.length === 0) return { a: undefined, b: undefined };
    const index = Math.max(0, currentIndex);
    return { a: queue[index], b: queue[index + 1] ?? queue[0] };
  }, [queue, currentIndex]);

  useEffect(() => {
    void loadTrack("a", suggestions.a);
    void loadTrack("b", suggestions.b);
  }, [loadTrack, suggestions.a, suggestions.b]);

  return (
    <div className="absolute inset-0 z-[95] flex flex-col gap-2 bg-[var(--dj-well)] p-2">
      {/* header: the panel's only chrome */}
      <header className="flex items-center gap-2 px-1">
        <h2 className="m-0 dj-label" style={{ fontSize: 11, letterSpacing: "0.3em" }}>
          Booth
        </h2>
        <span
          aria-hidden="true"
          className={`dj-led ${autoArmed ? "dj-led--on-amber" : ""}`}
          title={autoArmed ? "Auto-mix armed" : undefined}
        />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setLibraryOpen((prev) => !prev)}
            aria-pressed={libraryOpen}
            className={`dj-btn ${libraryOpen ? "dj-btn--lit" : ""}`}
          >
            Library
          </button>
          <button
            type="button"
            onClick={() => {
              setAutoPlan(computedPlan);
              setAutoArmed(false);
            }}
            disabled={!computedPlan}
            className={`dj-btn ${autoPlan ? "dj-btn--lit" : ""}`}
          >
            Auto Mix
          </button>
          <button
            type="button"
            onClick={() => setMidiOpen((prev) => !prev)}
            aria-pressed={midiOpen}
            className={`dj-btn ${midi.connected ? "dj-btn--green" : midiOpen ? "dj-btn--lit" : ""}`}
          >
            MIDI
          </button>
          <button
            type="button"
            onClick={() => setQuantise((prev) => !prev)}
            aria-pressed={quantise}
            className={`dj-btn ${quantise ? "dj-btn--lit" : ""}`}
          >
            Quantise
          </button>
          <button type="button" onClick={close} className="dj-btn">
            Exit
          </button>
        </div>
      </header>

      {/* auto-mix plan: state before action, so you can read the math */}
      {autoPlan ? (
        <div className="dj-panel flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
          <span className="dj-value dj-value--big">
            MIX {formatDeckTime(autoPlan.triggerAtMs)} · {Math.round(autoPlan.crossfadeMs / 1000)}s
          </span>
          <span className="dj-value">
            B {autoPlan.tempoMatch >= 0 ? "+" : ""}
            {(autoPlan.tempoMatch * 100).toFixed(1)}%
            {autoPlan.matchedBpm ? ` · ${autoPlan.matchedBpm.toFixed(1)} BPM` : ""}
          </span>
          <span className="dj-value">
            IN {formatDeckTime(autoPlan.bStartMs)} · GRID{" "}
            {autoPlan.beatAlignMs >= 0 ? "+" : ""}
            {Math.round(autoPlan.beatAlignMs)}ms
          </span>
          {autoPlan.warnings.map((warning) => (
            <span key={warning} className="dj-value" style={{ color: "var(--dj-led-amber)" }}>
              {warning}
            </span>
          ))}
          <button
            type="button"
            onClick={() => {
              autoRef.current = null;
              setAutoArmed((prev) => !prev);
            }}
            className={`dj-btn ml-auto ${autoArmed ? "dj-btn--red" : "dj-btn--amber"}`}
          >
            {autoArmed ? "Disarm" : "Arm"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAutoPlan(null);
              setAutoArmed(false);
            }}
            className="dj-btn"
          >
            Hide
          </button>
        </div>
      ) : null}

      {/* the ribbon: signature element, chroma-coded decks on a shared grid */}
      <div className="flex flex-col gap-1">
        {(["a", "b"] as const).map((side) => (
          <div key={side} className="flex items-center gap-2">
            <span
              className={`dj-deck-letter w-[12px] shrink-0 text-center ${
                side === "a" ? "dj-deck-a" : "dj-deck-b"
              }`}
            >
              {SIDE_LABEL[side]}
            </span>
            <div className="min-w-0 flex-1">
              <Waveform
                peaks={decks[side].peaks}
                status={decks[side].peaksStatus}
                positionMs={decks[side].positionMs}
                durationMs={decks[side].durationMs}
                grid={
                  decks[side].bpm
                    ? { bpm: decks[side].bpm, anchorMs: decks[side].anchorMs }
                    : null
                }
                hue={side}
                height={72}
                onSeek={(ms) => {
                  const element = audioRef.current[side];
                  if (element) element.currentTime = ms / 1000;
                }}
                label={`Deck ${SIDE_LABEL[side]}`}
              />
            </div>
            <span className="dj-value w-[52px] shrink-0 text-right">
              {formatDeckTime(decks[side].positionMs)}
            </span>
          </div>
        ))}
      </div>

      {/* decks + mixer */}
      <div className="flex min-h-0 flex-1 gap-2">
        {libraryOpen ? (
          <aside className="dj-panel flex w-[228px] shrink-0 flex-col gap-2 p-2">
            <div className="flex items-center justify-between">
              <span className="dj-label">Library → Deck {SIDE_LABEL[focused]}</span>
            </div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the queue…"
              aria-label="Search tracks for the decks"
              className="dj-well h-[28px] w-full px-2 text-[12px] text-text-primary outline-none"
            />
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
              {library.length === 0 ? (
                <p className="dj-value m-0">Nothing queued yet.</p>
              ) : (
                library.map((item) => (
                  <button
                    key={`${item.id}-${item.title}`}
                    type="button"
                    onClick={() => void loadTrack(focused, item)}
                    className="dj-row"
                  >
                    <span className="w-full truncate text-[11px] font-[500] text-text-primary">
                      {item.title}
                    </span>
                    <span className="dj-value w-full truncate">{item.artists}</span>
                  </button>
                ))
              )}
            </div>
          </aside>
        ) : null}

        <DeckPanel
          side="a"
          state={decks.a}
          focused={focused === "a"}
          canSync={Boolean(decks.b.track)}
          cueMode={cueMode === "a"}
          onFocus={() => setFocused("a")}
          onCue={() => cue("a")}
          onSync={() => syncTempo("a")}
          onNudge={(delta) => nudge("a", delta)}
          onPlay={() => void toggle("a")}
          onPause={() => void toggle("a")}
          onSeek={(ms) => {
            const element = audioRef.current.a;
            if (element) element.currentTime = ms / 1000;
          }}
          onTempo={(tempo) => setTempo("a", tempo)}
          onLoop={(beats) => setLoop("a", beats)}
          onExitLoop={() => exitLoop("a")}
          onHotcueSet={(index) => setHotcue("a", index)}
          onHotcueClear={(index) => clearHotcue("a", index)}
          onHotcueGo={(index) => goToHotcue("a", index)}
          onTap={() => tap("a")}
          onToggleCueMode={() => setCueMode((prev) => (prev === "a" ? null : "a"))}
        />

        {/* mixer: the milled column between the decks */}
        <section aria-label="Mixer" className="dj-metal flex w-[176px] shrink-0 flex-col gap-1.5 p-2">
          <div className="flex items-center justify-between">
            <span className="dj-label">Mixer</span>
            <span className="dj-value">{Math.round(master * 100)}%</span>
          </div>
          <div className="flex flex-1 justify-between px-1">
            <ChannelStrip
              side="a"
              state={decks.a}
              onEq={(band, value) => setEq("a", band, value)}
              onFx={(key, value) => setFx("a", key, value)}
              onTrim={(value) =>
                setDecks((prev) => ({ ...prev, a: { ...prev.a, trim: value } }))
              }
            />
            <ChannelStrip
              side="b"
              state={decks.b}
              onEq={(band, value) => setEq("b", band, value)}
              onFx={(key, value) => setFx("b", key, value)}
              onTrim={(value) =>
                setDecks((prev) => ({ ...prev, b: { ...prev.b, trim: value } }))
              }
            />
          </div>

          {/* crossfader */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="dj-deck-letter dj-deck-a">A</span>
              <span className="dj-label">Crossfader</span>
              <span className="dj-deck-letter dj-deck-b">B</span>
            </div>
            <input
              type="range"
              aria-label="Crossfader"
              min={0}
              max={1}
              step={0.01}
              value={crossfader}
              onChange={(event) => setCrossfader(Number(event.target.value))}
              className="w-full accent-accent-primary"
            />
          </div>

          <div className="flex items-center justify-center gap-2 border-t pt-1" style={{ borderColor: "var(--dj-line-strong)" }}>
            <Knob
              label="Master"
              min={0}
              max={1}
              step={0.01}
              defaultValue={1}
              value={master}
              size={34}
              format={(v) => `${Math.round(v * 100)}`}
              onChange={setMaster}
            />
          </div>
        </section>

        <DeckPanel
          side="b"
          state={decks.b}
          focused={focused === "b"}
          canSync={Boolean(decks.a.track)}
          cueMode={cueMode === "b"}
          onFocus={() => setFocused("b")}
          onCue={() => cue("b")}
          onSync={() => syncTempo("b")}
          onNudge={(delta) => nudge("b", delta)}
          onPlay={() => void toggle("b")}
          onPause={() => void toggle("b")}
          onSeek={(ms) => {
            const element = audioRef.current.b;
            if (element) element.currentTime = ms / 1000;
          }}
          onTempo={(tempo) => setTempo("b", tempo)}
          onLoop={(beats) => setLoop("b", beats)}
          onExitLoop={() => exitLoop("b")}
          onHotcueSet={(index) => setHotcue("b", index)}
          onHotcueClear={(index) => clearHotcue("b", index)}
          onHotcueGo={(index) => goToHotcue("b", index)}
          onTap={() => tap("b")}
          onToggleCueMode={() => setCueMode((prev) => (prev === "b" ? null : "b"))}
        />
      </div>

      <audio ref={(el) => void (audioRef.current.a = el)} preload="auto" />
      <audio ref={(el) => void (audioRef.current.b = el)} preload="auto" />

      {midiOpen ? <MidiPanel midi={midi} onClose={() => setMidiOpen(false)} /> : null}
    </div>
  );
}

export default memo(DjSurface);
