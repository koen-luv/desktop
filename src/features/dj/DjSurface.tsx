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
  TEMPO_RANGE,
  tempoToRate,
} from "./mixMath";
import { playerRuntime } from "@/features/player/engine/runtime";
import { createDeckChain, NEUTRAL_EQ, type EqBand } from "./deckAudio";
import { createDeckFx, NEUTRAL_FX, type FxState } from "./fx";
import { loopedPosition, makeLoop, tapTempo } from "./loopMath";
import { quantizePosition } from "./bpm";

/**
 * DJ mode.
 *
 * Two decks flanking a mixer, with a waveform ribbon on top. It uses the same
 * tokens, radii and type scale as the rest of the app — panels are `bg-bg-surface`
 * cards, titles use the home rows' type, knobs draw with the accent — so it reads
 * as one product rather than a themed skin dropped on top.
 *
 * It owns its own media elements so a mix cannot fight the queue, and loads
 * each track as a same-origin blob so the audio graph is never tainted by
 * cross-origin media (which would silently mute the decks).
 */

interface DeckState {
  track: Track | null;
  /** Same-origin blob URL for the loaded stream. */
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
  peaks: TrackAnalysis["peaks"] | null;
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

/* ── Deck panel ───────────────────────────────────────────────────────────── */

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
  onTempo: (value: number) => void;
  onLoop: (beats: number) => void;
  onExitLoop: () => void;
  onHotcueSet: (index: number) => void;
  onHotcueClear: (index: number) => void;
  onHotcueGo: (index: number) => void;
  onTap: () => void;
  onToggleCueMode: () => void;
}) {
  const loopBeats: Array<{ beats: number; label: string }> = [
    { beats: 0.5, label: "½" },
    { beats: 1, label: "1" },
    { beats: 2, label: "2" },
    { beats: 4, label: "4" },
    { beats: 8, label: "8" },
  ];

  const chip = "rounded-[10px] border border-border-primary px-[10px] text-[11px] font-[500] transition-colors active:scale-[0.97] disabled:opacity-35";

  return (
    <section
      onClick={onFocus}
      aria-label={`Deck ${SIDE_LABEL[side]}`}
      className={`flex min-w-0 flex-1 flex-col gap-[10px] rounded-[16px] border bg-bg-surface p-3 transition-colors ${
        focused ? "border-accent-primary/50" : "border-border-primary/60"
      }`}
    >
      <div className="flex items-center gap-[6px]">
        <span className="text-[11px] font-[600] tracking-[0.16em] text-text-tertiary">
          DECK {SIDE_LABEL[side]}
        </span>
        <span
          aria-hidden="true"
          className={`h-[6px] w-[6px] rounded-full ${
            state.playing ? "bg-accent-primary" : state.track ? "bg-text-tertiary" : "bg-border-primary"
          }`}
        />
      </div>

      <div className="min-h-[36px]">
        <p className="m-0 truncate text-[13.5px] font-[550] tracking-[-0.014em] text-text-primary">
          {state.track ? state.track.title : "Empty deck"}
        </p>
        <p className="m-0 truncate text-[13px] text-text-secondary">
          {state.track ? state.track.artists : "Pick a track from the library"}
        </p>
      </div>

      {state.error ? <p className="m-0 text-[12px] text-text-secondary">{state.error}</p> : null}

      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[15px] tabular-nums text-text-primary">
          {formatDeckTime(state.positionMs)}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-text-tertiary">
          −{formatDeckTime(Math.max(0, state.durationMs - state.positionMs))}
        </span>
      </div>

      <div className="flex items-center gap-[6px]">
        <button type="button" onClick={onCue} disabled={!state.track} className={`${chip} text-text-primary`}>
          Cue
        </button>
        <button
          type="button"
          onClick={state.playing ? onPause : onPlay}
          disabled={!state.track || state.loading}
          className={`${chip} flex-1 bg-accent-primary text-accent-ink disabled:bg-bg-panel`}
        >
          {state.loading ? "…" : state.playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={onSync}
          disabled={!canSync}
          className={`${chip} ${Math.abs(state.tempo) > 0.001 ? "bg-accent-soft text-accent-primary" : "text-text-primary"}`}
        >
          Sync
        </button>
      </div>

      <div className="flex items-center gap-[6px]">
        <button type="button" onClick={() => onNudge(-500)} disabled={!state.track} className={`${chip} flex-1 text-text-secondary`}>
          ◄ Nudge
        </button>
        <button type="button" onClick={() => onNudge(500)} disabled={!state.track} className={`${chip} flex-1 text-text-secondary`}>
          Nudge ►
        </button>
      </div>

      <div className="flex items-center gap-[5px]">
        <span className="w-[34px] text-[10px] uppercase tracking-[0.14em] text-text-tertiary">Loop</span>
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
              className={`${chip} h-[26px] w-[30px] p-0 ${active ? "bg-accent-soft text-accent-primary" : "text-text-secondary"}`}
            >
              {label}
            </button>
          );
        })}
        <button type="button" onClick={onExitLoop} disabled={!state.loop} className={`${chip} h-[26px] flex-1 p-0 text-text-secondary`}>
          Exit
        </button>
      </div>

      <div className="flex items-center gap-[5px]">
        <span className="w-[34px] text-[10px] uppercase tracking-[0.14em] text-text-tertiary">Cue</span>
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
            className={`${chip} h-[26px] w-[30px] p-0 ${
              cue !== null
                ? "bg-accent-primary text-accent-ink"
                : cueMode
                  ? "border-accent-primary/50 text-accent-primary"
                  : "text-text-tertiary"
            }`}
          >
            {index + 1}
          </button>
        ))}
        <button
          type="button"
          onClick={onToggleCueMode}
          aria-pressed={cueMode}
          className={`${chip} h-[26px] flex-1 p-0 ${cueMode ? "bg-accent-soft text-accent-primary" : "text-text-secondary"}`}
        >
          {cueMode ? "Arming" : "Set"}
        </button>
      </div>

      <div>
        <div className="mb-[6px] flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">Tempo</span>
          <span className="font-mono text-[11px] tabular-nums text-text-secondary">
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

      <button type="button" onClick={onTap} disabled={!state.track} className={`${chip} w-full text-text-secondary`}>
        Tap
      </button>
    </section>
  );
}

/* ── Channel strip ────────────────────────────────────────────────────────── */

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
  return (
    <div className="flex flex-1 flex-col items-center gap-[6px]">
      <span className="text-[11px] font-[600] tracking-[0.16em] text-text-tertiary">
        {SIDE_LABEL[side]}
      </span>
      <Knob label="Trim" min={0} max={1} step={0.01} defaultValue={1} value={state.trim} size={30} format={(v) => `${Math.round(v * 100)}`} onChange={onTrim} />
      <Knob label="High" min={-24} max={12} step={1} defaultValue={0} value={state.eq.high} size={30} format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}`} onChange={(n) => onEq("high", n)} />
      <Knob label="Mid" min={-24} max={12} step={1} defaultValue={0} value={state.eq.mid} size={30} format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}`} onChange={(n) => onEq("mid", n)} />
      <Knob label="Low" min={-24} max={12} step={1} defaultValue={0} value={state.eq.low} size={30} format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}`} onChange={(n) => onEq("low", n)} />
      <div className="my-[2px] h-px w-[26px] bg-border-primary" />
      <Knob label="Filt" min={0} max={1} step={0.01} defaultValue={1} value={state.fx.filter} size={30} format={(v) => `${Math.round(v * 100)}`} onChange={(n) => onFx("filter", n)} />
      <Knob label="Echo" min={0} max={1} step={0.01} defaultValue={0} value={state.fx.echo} size={30} format={(v) => `${Math.round(v * 100)}`} onChange={(n) => onFx("echo", n)} />
      <Knob label="Verb" min={0} max={1} step={0.01} defaultValue={0} value={state.fx.reverb} size={30} format={(v) => `${Math.round(v * 100)}`} onChange={(n) => onFx("reverb", n)} />
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
  const objectUrls = useRef<{ a: string | null; b: string | null }>({ a: null, b: null });
  const gainsRef = useRef<{
    ctx: AudioContext;
    a: GainNode;
    b: GainNode;
    eq: { a: ReturnType<typeof createDeckChain>; b: ReturnType<typeof createDeckChain> };
    fx: { a: ReturnType<typeof createDeckFx>; b: ReturnType<typeof createDeckFx> };
  } | null>(null);

  const crossfade = useMemo(() => crossfadeGains(crossfader), [crossfader]);

  /**
   * Build the per-deck audio graph. Each deck plays a same-origin blob, so
   * `createMediaElementSource` is never tainted and the graph always has
   * signal. If the graph cannot be built at all we fall back to plain element
   * playback — silence is worse than losing the EQ.
   */
  const ensureGraph = useCallback(() => {
    if (gainsRef.current) return gainsRef.current;
    const a = audioRef.current.a;
    const b = audioRef.current.b;
    if (!a || !b) return null;
    try {
      const ctx = new AudioContext();
      const gainA = ctx.createGain();
      const gainB = ctx.createGain();
      const masterGain = ctx.createGain();
      masterGain.gain.value = master;
      masterGain.connect(ctx.destination);
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
    } catch (error) {
      log("yellow", "dj", `audio graph unavailable, playing directly: ${String(error)}`);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply fader + trim + master + eq + fx continuously.
  useEffect(() => {
    const graph = ensureGraph();
    const a = audioRef.current.a;
    const b = audioRef.current.b;
    if (!a || !b) return;
    if (!graph) {
      // No graph: drive the elements directly so audio still works.
      a.volume = Math.min(1, Math.max(0, deckGain(crossfade, "a", decks.a.trim) * master));
      b.volume = Math.min(1, Math.max(0, deckGain(crossfade, "b", decks.b.trim) * master));
      return;
    }
    graph.a.gain.value = deckGain(crossfade, "a", decks.a.trim);
    graph.b.gain.value = deckGain(crossfade, "b", decks.b.trim);
    if (masterGainRef.current) masterGainRef.current.gain.value = master;
    graph.eq.a.setEq(decks.a.eq);
    graph.eq.b.setEq(decks.b.eq);
    graph.fx.a.update(decks.a.fx, decks.a.bpm ?? 120);
    graph.fx.b.update(decks.b.fx, decks.b.bpm ?? 120);
  }, [crossfade, decks.a, decks.b, master, ensureGraph]);

  /**
   * Deck clocks, for the readouts and the waveform playheads only.
   *
   * These used to force deck B onto deck A's position whenever they differed
   * by more than 80 ms. Two different songs never share a position, so the
   * moment both played, B was re-seeked on every tick — simultaneous playback
   * was impossible. Beat-matching is tempo (and the Sync button), not jumping
   * one deck onto the other's timeline.
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      const a = audioRef.current.a;
      const b = audioRef.current.b;
      if (!a || !b) return;
      setDecks((prev) => ({
        a: { ...prev.a, positionMs: a.currentTime * 1000, durationMs: (a.duration || 0) * 1000 },
        b: { ...prev.b, positionMs: b.currentTime * 1000, durationMs: (b.duration || 0) * 1000 },
      }));
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Beat loops wrap each deck back to its loop start.
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

  /**
   * Analyse an already-downloaded track. `bytes` is shared with the deck's
   * blob URL so nothing is fetched twice; on failure the deck still plays, it
   * just has no waveform or grid.
   */
  const analyseBytes = useCallback(async (side: "a" | "b", bytes: ArrayBuffer) => {
    try {
      const ctx = new AudioContext();
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
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
          bpm: prev[side].bpm ?? analysis.bpm,
          anchorMs: analysis.anchorMs,
        },
      }));
    } catch {
      setDecks((prev) => ({ ...prev, [side]: { ...prev[side], peaksStatus: "unavailable" } }));
    }
  }, []);

  /**
   * Load a track onto a deck. The stream is fetched once, turned into a
   * same-origin blob URL (so the audio graph can read it), and the same bytes
   * feed the analysis pass.
   */
  const loadTrack = useCallback(
    async (side: "a" | "b", track: Track | undefined) => {
      if (!track) return;
      setDecks((prev) => ({ ...prev, [side]: { ...prev[side], loading: true, error: null } }));
      try {
        const stream = await resolvePlaybackStream(track);
        const element = audioRef.current[side];
        if (!element || !stream.url) throw new Error("No stream available");

        const response = await fetch(stream.url);
        if (!response.ok) throw new Error(`Stream returned ${response.status}`);
        const bytes = await response.arrayBuffer();

        const blob = new Blob([bytes], {
          type: stream.mimeType || "audio/mpeg",
        });
        const objectUrl = URL.createObjectURL(blob);
        if (objectUrls.current[side]) URL.revokeObjectURL(objectUrls.current[side] as string);
        objectUrls.current[side] = objectUrl;

        element.src = objectUrl;
        element.load();

        setDecks((prev) => ({
          ...prev,
          [side]: {
            ...prev[side],
            track,
            src: objectUrl,
            loading: false,
            playing: false,
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

        void analyseBytes(side, bytes);
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
    [analyseBytes],
  );

  const toggle = useCallback(
    async (side: "a" | "b") => {
      const element = audioRef.current[side];
      if (!element) return;
      const graph = ensureGraph();
      if (graph?.ctx.state === "suspended") await graph.ctx.resume();
      if (element.paused) {
        try {
          await element.play();
          setDecks((prev) => ({ ...prev, [side]: { ...prev[side], playing: true, error: null } }));
        } catch (error) {
          // A rejected play() used to leave the deck claiming it was playing
          // while silent; surface it instead.
          setDecks((prev) => ({
            ...prev,
            [side]: {
              ...prev[side],
              playing: false,
              error: error instanceof Error ? error.message : "Could not start playback",
            },
          }));
        }
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

  const syncTempo = useCallback(
    (side: "a" | "b") => {
      const other = side === "a" ? "b" : "a";
      const target = decks[side];
      const source = decks[other];
      // Copying the other deck's slider only beat-matches when both files
      // happen to share a BPM. Match the effective tempos instead:
      // thisRate = (other base BPM × other rate) / this base BPM.
      let tempo = source.tempo;
      if (target.bpm && source.bpm) {
        const ratio = (source.bpm * tempoToRate(source.tempo)) / target.bpm;
        tempo = Math.min(TEMPO_RANGE, Math.max(-TEMPO_RANGE, ratio - 1));
      }
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
    setDecks((prev) => ({
      ...prev,
      [side]: { ...prev[side], eq: { ...prev[side].eq, [band]: value } },
    }));
  }, []);

  const setLoop = useCallback(
    (side: "a" | "b", beats: number) => {
      const element = audioRef.current[side];
      if (!element) return;
      // Read the transport, not the 250 ms-cached state: a loop/hotcue taken
      // from the cached position lands up to a quarter second off the grid.
      const positionMs = element.currentTime * 1000;
      setDecks((prev) => {
        const deck = prev[side];
        const bpm = deck.bpm ?? 120;
        const start =
          quantise && deck.bpm
            ? quantizePosition(positionMs, deck.bpm, deck.anchorMs)
            : positionMs;
        const loop = makeLoop(start, beats, bpm);
        return { ...prev, [side]: { ...deck, loop } };
      });
      if (element.paused) {
        const graph = ensureGraph();
        if (graph?.ctx.state === "suspended") void graph.ctx.resume();
        void element
          .play()
          .then(() =>
            setDecks((prev) => ({ ...prev, [side]: { ...prev[side], playing: true } })),
          )
          .catch(() => undefined);
      }
    },
    [ensureGraph, quantise],
  );

  const exitLoop = useCallback((side: "a" | "b") => {
    setDecks((prev) => ({ ...prev, [side]: { ...prev[side], loop: null } }));
  }, []);

  const setHotcue = useCallback(
    (side: "a" | "b", index: number) => {
      const element = audioRef.current[side];
      if (!element) return;
      const positionMs = element.currentTime * 1000;
      setDecks((prev) => {
        const deck = prev[side];
        const hotcues = [...deck.hotcues];
        hotcues[index] =
          quantise && deck.bpm
            ? quantizePosition(positionMs, deck.bpm, deck.anchorMs)
            : positionMs;
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
      const point = decks[side].hotcues[index];
      if (!element || point === null || point === undefined) return;
      element.currentTime = point / 1000;
    },
    [decks],
  );

  const tapsRef = useRef<{ a: number[]; b: number[] }>({ a: [], b: [] });
  const tap = useCallback((side: "a" | "b") => {
    const now = performance.now();
    const taps = tapsRef.current[side];
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
      if (objectUrls.current[side]) {
        URL.revokeObjectURL(objectUrls.current[side] as string);
        objectUrls.current[side] = null;
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

  // Auto-mix.
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

  // MIDI action bus.
  const applyMidiAction = useCallback(
    (action: DjAction) => {
      switch (action.kind) {
        case "selectDeck": setFocused(action.deck); break;
        case "togglePlay": void toggle(action.deck); break;
        case "cue": cue(action.deck); break;
        case "sync": syncTempo(action.deck); break;
        case "loopBeats": setLoop(action.deck, action.beats); break;
        case "exitLoop": exitLoop(action.deck); break;
        case "hotcueSet": setHotcue(action.deck, action.index); break;
        case "hotcueGo": goToHotcue(action.deck, action.index); break;
        case "hotcueClear": clearHotcue(action.deck, action.index); break;
        case "eq": setEq(action.deck, action.band, action.value); break;
        case "fx": setFx(action.deck, action.key, action.value); break;
        case "trim":
          setDecks((prev) => ({
            ...prev,
            [action.deck]: { ...prev[action.deck], trim: action.value },
          }));
          break;
        case "tempo": setTempo(action.deck, action.value); break;
        case "crossfader": setCrossfader(action.value); break;
        case "master": setMaster(action.value); break;
        case "quantise": setQuantise((prev) => !prev); break;
      }
    },
    [toggle, cue, syncTempo, setLoop, exitLoop, setHotcue, goToHotcue, clearHotcue, setEq, setFx, setTempo],
  );

  const midi = useMidi({ focused, onAction: applyMidiAction });

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

  const suggestions = useMemo(() => {
    if (queue.length === 0) return { a: undefined, b: undefined };
    const index = Math.max(0, currentIndex);
    return { a: queue[index], b: queue[index + 1] ?? queue[0] };
  }, [queue, currentIndex]);

  /**
   * DJ mode owns the output while it is open. The queue used to keep playing
   * underneath the decks — two songs at once — and every advance re-seeded the
   * decks mid-mix. Pause it once, like the stem mixer; it stays paused after
   * closing because the user chose the decks.
   */
  useEffect(() => {
    const status = usePlayerStore.getState().status;
    if (status === "playing" || status === "loading") playerRuntime?.pause();
  }, []);

  // Seed the decks with the current and next queue track exactly once, when
  // the queue first becomes available. Later queue changes must not wipe a mix.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !suggestions.a) return;
    seededRef.current = true;
    void loadTrack("a", suggestions.a);
    void loadTrack("b", suggestions.b);
  }, [loadTrack, suggestions.a, suggestions.b]);

  const chip = "rounded-[10px] border border-border-primary px-[12px] text-[12px] font-[500] transition-colors active:scale-[0.97] disabled:opacity-35";

  // `data-dialog-container` marks this as a blocking overlay so the global
  // transport shortcuts (space, arrows, N/P) cannot start the paused queue
  // underneath the decks.
  return (
    <div
      data-dialog-container="true"
      className="absolute inset-0 z-[95] flex flex-col gap-2 overflow-y-auto bg-bg-primary p-3"
    >
      {/* header */}
      <header className="flex flex-wrap items-center gap-[8px]">
        <h2 className="m-0 text-[21px] font-semibold tracking-tight text-text-primary">DJ</h2>
        <div className="ml-auto flex flex-wrap items-center gap-[6px]">
          <button type="button" onClick={() => setLibraryOpen((p) => !p)} aria-pressed={libraryOpen} className={`${chip} ${libraryOpen ? "bg-accent-soft text-accent-primary" : "text-text-secondary"}`}>
            Library
          </button>
          <button
            type="button"
            onClick={() => { setAutoPlan(computedPlan); setAutoArmed(false); }}
            disabled={!computedPlan}
            className={`${chip} ${autoPlan ? "bg-accent-soft text-accent-primary" : "text-text-secondary"}`}
          >
            Auto Mix
          </button>
          <button type="button" onClick={() => setMidiOpen((p) => !p)} aria-pressed={midiOpen} className={`${chip} ${midi.connected ? "bg-accent-soft text-accent-primary" : "text-text-secondary"}`}>
            MIDI
          </button>
          <button type="button" onClick={() => setQuantise((p) => !p)} aria-pressed={quantise} className={`${chip} ${quantise ? "bg-accent-soft text-accent-primary" : "text-text-secondary"}`}>
            Quantise
          </button>
          <button type="button" onClick={close} className={`${chip} text-text-primary`}>
            Exit
          </button>
        </div>
      </header>

      {/* auto-mix plan */}
      {autoPlan ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[16px] border border-border-primary/60 bg-bg-surface px-3 py-2">
          <span className="text-[13.5px] font-[550] tracking-[-0.014em] text-text-primary">
            Mix at {formatDeckTime(autoPlan.triggerAtMs)} · {Math.round(autoPlan.crossfadeMs / 1000)}s fade
          </span>
          <span className="text-[13px] text-text-secondary">
            B {autoPlan.tempoMatch >= 0 ? "+" : ""}
            {(autoPlan.tempoMatch * 100).toFixed(1)}%
            {autoPlan.matchedBpm ? ` · ${autoPlan.matchedBpm.toFixed(1)} BPM` : ""}
          </span>
          <span className="text-[13px] text-text-tertiary">
            In {formatDeckTime(autoPlan.bStartMs)} · grid {autoPlan.beatAlignMs >= 0 ? "+" : ""}
            {Math.round(autoPlan.beatAlignMs)}ms
          </span>
          {autoPlan.warnings.map((warning) => (
            <span key={warning} className="text-[12px] text-text-secondary">{warning}</span>
          ))}
          <button
            type="button"
            onClick={() => { autoRef.current = null; setAutoArmed((p) => !p); }}
            className={`${chip} ml-auto ${autoArmed ? "bg-accent-primary text-accent-ink" : "bg-accent-soft text-accent-primary"}`}
          >
            {autoArmed ? "Disarm" : "Arm"}
          </button>
          <button type="button" onClick={() => { setAutoPlan(null); setAutoArmed(false); }} className={`${chip} text-text-secondary`}>
            Hide
          </button>
        </div>
      ) : null}

      {/* waveform ribbon */}
      <div className="flex flex-col gap-[6px]">
        {(["a", "b"] as const).map((side) => (
          <div key={side} className="flex items-center gap-[10px]">
            <span className="w-[16px] shrink-0 text-center text-[11px] font-[600] tracking-[0.16em] text-text-tertiary">
              {SIDE_LABEL[side]}
            </span>
            <div className="min-w-0 flex-1">
              <Waveform
                peaks={decks[side].peaks}
                status={decks[side].peaksStatus}
                positionMs={decks[side].positionMs}
                durationMs={decks[side].durationMs}
                grid={decks[side].bpm ? { bpm: decks[side].bpm, anchorMs: decks[side].anchorMs } : null}
                hue={side}
                height={70}
                onSeek={(ms) => {
                  const element = audioRef.current[side];
                  if (element) element.currentTime = ms / 1000;
                }}
                label={`Deck ${SIDE_LABEL[side]}`}
              />
            </div>
            <span className="w-[52px] shrink-0 text-right font-mono text-[11px] tabular-nums text-text-secondary">
              {formatDeckTime(decks[side].positionMs)}
            </span>
          </div>
        ))}
      </div>

      {/* decks + mixer */}
      <div className="flex min-h-0 flex-1 flex-wrap gap-2">
        {libraryOpen ? (
          <aside className="flex w-[232px] shrink-0 flex-col gap-[8px] rounded-[16px] border border-border-primary/60 bg-bg-surface p-3">
            <span className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
              Library → Deck {SIDE_LABEL[focused]}
            </span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the queue…"
              aria-label="Search tracks for the decks"
              className="h-[32px] w-full rounded-[10px] border border-border-primary bg-transparent px-[10px] text-[13px] text-text-primary outline-none focus-visible:ring-4 focus-visible:ring-accent-soft"
            />
            <div className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto">
              {library.length === 0 ? (
                <p className="m-0 text-[13px] text-text-tertiary">Nothing queued yet.</p>
              ) : (
                library.map((item) => (
                  <button
                    key={`${item.id}-${item.title}`}
                    type="button"
                    onClick={() => void loadTrack(focused, item)}
                    className="flex w-full flex-col items-start rounded-[10px] px-[8px] py-[6px] text-left transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-soft"
                  >
                    <span className="w-full truncate text-[13.5px] font-[550] tracking-[-0.014em] text-text-primary">
                      {item.title}
                    </span>
                    <span className="w-full truncate text-[13px] text-text-secondary">
                      {item.artists}
                    </span>
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
          onNudge={(d) => nudge("a", d)}
          onPlay={() => void toggle("a")}
          onPause={() => void toggle("a")}
          onTempo={(t) => setTempo("a", t)}
          onLoop={(beats) => setLoop("a", beats)}
          onExitLoop={() => exitLoop("a")}
          onHotcueSet={(i) => setHotcue("a", i)}
          onHotcueClear={(i) => clearHotcue("a", i)}
          onHotcueGo={(i) => goToHotcue("a", i)}
          onTap={() => tap("a")}
          onToggleCueMode={() => setCueMode((p) => (p === "a" ? null : "a"))}
        />

        <section
          aria-label="Mixer"
          className="flex w-[184px] shrink-0 flex-col gap-[8px] rounded-[16px] border border-border-primary/60 bg-bg-panel p-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">Mixer</span>
            <span className="font-mono text-[11px] tabular-nums text-text-secondary">
              {Math.round(master * 100)}%
            </span>
          </div>
          <div className="flex flex-1 justify-between px-[2px]">
            <ChannelStrip
              side="a"
              state={decks.a}
              onEq={(band, value) => setEq("a", band, value)}
              onFx={(key, value) => setFx("a", key, value)}
              onTrim={(value) => setDecks((prev) => ({ ...prev, a: { ...prev.a, trim: value } }))}
            />
            <ChannelStrip
              side="b"
              state={decks.b}
              onEq={(band, value) => setEq("b", band, value)}
              onFx={(key, value) => setFx("b", key, value)}
              onTrim={(value) => setDecks((prev) => ({ ...prev, b: { ...prev.b, trim: value } }))}
            />
          </div>

          <div>
            <div className="mb-[6px] flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">A</span>
              <span className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">Crossfader</span>
              <span className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">B</span>
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

          <div className="flex justify-center border-t border-border-primary pt-[8px]">
            <Knob label="Master" min={0} max={1} step={0.01} defaultValue={1} value={master} size={34} format={(v) => `${Math.round(v * 100)}`} onChange={setMaster} />
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
          onNudge={(d) => nudge("b", d)}
          onPlay={() => void toggle("b")}
          onPause={() => void toggle("b")}
          onTempo={(t) => setTempo("b", t)}
          onLoop={(beats) => setLoop("b", beats)}
          onExitLoop={() => exitLoop("b")}
          onHotcueSet={(i) => setHotcue("b", i)}
          onHotcueClear={(i) => clearHotcue("b", i)}
          onHotcueGo={(i) => goToHotcue("b", i)}
          onTap={() => tap("b")}
          onToggleCueMode={() => setCueMode((p) => (p === "b" ? null : "b"))}
        />
      </div>

      <audio ref={(el) => void (audioRef.current.a = el)} preload="auto" />
      <audio ref={(el) => void (audioRef.current.b = el)} preload="auto" />

      {midiOpen ? <MidiPanel midi={midi} onClose={() => setMidiOpen(false)} /> : null}
    </div>
  );
}

export default memo(DjSurface);
