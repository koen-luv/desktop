import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayerStore } from "@/features/player";
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

/**
 * DJ mode surface (desktop).
 *
 * Two independent decks, each with its own media element, trim, tempo and
 * transport, mixed through Web Audio gain nodes on a shared crossfader. It is
 * deliberately separate from the normal player: DJ mode owns its own decks so a
 * mix can't fight the queue, and closing it releases them.
 *
 * Tracks come from the current queue; nothing is re-resolved differently from
 * normal playback — the same resolver provides the stream URL.
 */

interface DeckState {
  track: Track | null;
  playing: boolean;
  loading: boolean;
  trim: number;
  tempo: number; // -0.08 … 0.08
  positionMs: number;
  durationMs: number;
  error: string | null;
}

const EMPTY_DECK: DeckState = {
  track: null,
  playing: false,
  loading: false,
  trim: 1,
  tempo: 0,
  positionMs: 0,
  durationMs: 0,
  error: null,
};

function Deck({
  side,
  state,
  gain,
  onPlay,
  onPause,
  onSeek,
  onTrim,
  onTempo,
}: {
  side: "A" | "B";
  state: DeckState;
  gain: number;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (ms: number) => void;
  onTrim: (value: number) => void;
  onTempo: (value: number) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-[16px] border border-border-primary/60 bg-bg-panel/80 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-[600] tracking-[0.2em] text-text-tertiary">DECK {side}</span>
        <span className="font-mono text-[11px] text-text-tertiary">{Math.round(gain * 100)}%</span>
      </div>

      <div className="min-h-[42px]">
        <p className="m-0 truncate text-[14px] font-[600] text-text-primary">
          {state.track ? state.track.title : "Empty deck"}
        </p>
        <p className="m-0 truncate text-[12px] text-text-secondary">
          {state.track ? state.track.artists : "Load from the queue"}
        </p>
      </div>

      {state.error ? (
        <p className="m-0 text-[11px] text-red-400">{state.error}</p>
      ) : null}

      <input
        type="range"
        aria-label={`Deck ${side} position`}
        min={0}
        max={Math.max(1, state.durationMs)}
        value={state.positionMs}
        onChange={(event) => onSeek(Number(event.target.value))}
        className="w-full accent-accent-primary"
      />
      <div className="flex justify-between font-mono text-[10px] text-text-tertiary">
        <span>{formatDeckTime(state.positionMs)}</span>
        <span>{formatDeckTime(state.durationMs)}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={state.playing ? onPause : onPlay}
          disabled={!state.track || state.loading}
          className="h-[38px] min-w-[86px] rounded-[10px] border-0 bg-accent-primary px-4 text-[13px] font-[600] text-accent-ink disabled:opacity-40"
        >
          {state.loading ? "…" : state.playing ? "Pause" : "Play"}
        </button>
        <label className="flex flex-1 items-center gap-2 text-[11px] text-text-tertiary">
          Trim
          <input
            type="range"
            aria-label={`Deck ${side} trim`}
            min={0}
            max={1}
            step={0.01}
            value={state.trim}
            onChange={(event) => onTrim(Number(event.target.value))}
            className="w-full accent-accent-primary"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-[11px] text-text-tertiary">
        Tempo
        <input
          type="range"
          aria-label={`Deck ${side} tempo`}
          min={-0.08}
          max={0.08}
          step={0.005}
          value={state.tempo}
          onChange={(event) => onTempo(Number(event.target.value))}
          className="w-full accent-accent-primary"
        />
        <span className="w-[46px] shrink-0 text-right font-mono text-[10px]">
          {(state.tempo * 100).toFixed(1)}%
        </span>
      </label>
    </div>
  );
}

function DjSurface({ onClose }: { onClose: () => void }) {
  const queue = usePlayerStore((state) => state.queue);
  const currentIndex = usePlayerStore((state) => state.currentIndex);
  const [decks, setDecks] = useState<{ a: DeckState; b: DeckState }>({
    a: EMPTY_DECK,
    b: EMPTY_DECK,
  });
  const [crossfader, setCrossfader] = useState(0.5);
  const audioRef = useRef<{ a: HTMLAudioElement | null; b: HTMLAudioElement | null }>({
    a: null,
    b: null,
  });
  const gainsRef = useRef<{ ctx: AudioContext; a: GainNode; b: GainNode } | null>(null);

  const crossfade = useMemo(() => crossfadeGains(crossfader), [crossfader]);

  const ensureGraph = useCallback(() => {
    if (gainsRef.current) return gainsRef.current;
    const ctx = new AudioContext();
    const a = audioRef.current.a;
    const b = audioRef.current.b;
    if (!a || !b) return null;
    const gainA = ctx.createGain();
    const gainB = ctx.createGain();
    ctx.createMediaElementSource(a).connect(gainA).connect(ctx.destination);
    ctx.createMediaElementSource(b).connect(gainB).connect(ctx.destination);
    gainsRef.current = { ctx, a: gainA, b: gainB };
    return gainsRef.current;
  }, []);

  // Apply fader + trim continuously.
  useEffect(() => {
    const graph = ensureGraph();
    if (!graph) return;
    graph.a.gain.value = deckGain(crossfade, "a", decks.a.trim);
    graph.b.gain.value = deckGain(crossfade, "b", decks.b.trim);
  }, [crossfade, decks.a.trim, decks.b.trim, ensureGraph]);

  // Transport clocks.
  useEffect(() => {
    const id = window.setInterval(() => {
      const a = audioRef.current.a;
      const b = audioRef.current.b;
      if (!a || !b) return;
      const master = a.paused ? b.currentTime * 1000 : a.currentTime * 1000;
      setDecks((prev) => ({
        a: { ...prev.a, positionMs: a.currentTime * 1000, durationMs: (a.duration || 0) * 1000 },
        b: {
          ...prev.b,
          positionMs: b.currentTime * 1000,
          durationMs: (b.duration || 0) * 1000,
        },
      }));
      // Keep the quieter deck phase-locked to the master clock.
      if (!a.paused && !b.paused && needsResync(master, b.currentTime * 1000)) {
        b.currentTime = master / 1000;
      }
    }, 250);
    return () => window.clearInterval(id);
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
          [side]: { ...prev[side], track, loading: false, durationMs: 0, positionMs: 0 },
        }));
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
    [],
  );

  const toggle = useCallback(async (side: "a" | "b") => {
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
  }, [ensureGraph]);

  const close = useCallback(() => {
    for (const side of ["a", "b"] as const) {
      const element = audioRef.current[side];
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
    }
    void gainsRef.current?.ctx.close().catch(() => undefined);
    gainsRef.current = null;
    onClose();
  }, [onClose]);

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
    <div className="absolute inset-0 z-[95] flex flex-col gap-3 bg-bg-primary/98 p-3 backdrop-blur-xl">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-[15px] font-[600]">DJ mode</h2>
        <button
          type="button"
          onClick={close}
          className="h-[32px] rounded-[10px] border border-border-primary px-3 text-[12px]"
        >
          Exit
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <Deck
          side="A"
          state={decks.a}
          gain={deckGain(crossfade, "a", decks.a.trim)}
          onPlay={() => void toggle("a")}
          onPause={() => void toggle("a")}
          onSeek={(ms) => {
            const element = audioRef.current.a;
            if (element) element.currentTime = ms / 1000;
          }}
          onTrim={(trim) => setDecks((prev) => ({ ...prev, a: { ...prev.a, trim } }))}
          onTempo={(tempo) => {
            setDecks((prev) => ({ ...prev, a: { ...prev.a, tempo } }));
            const element = audioRef.current.a;
            if (element) element.playbackRate = tempoToRate(tempo);
          }}
        />

        <div className="flex w-[64px] shrink-0 flex-col items-center justify-center gap-2">
          <span className="text-[10px] tracking-[0.2em] text-text-tertiary">A</span>
          <input
            type="range"
            aria-label="Crossfader"
            min={0}
            max={1}
            step={0.01}
            value={crossfader}
            onChange={(event) => setCrossfader(Number(event.target.value))}
            className="h-[220px] accent-accent-primary"
            style={{ writingMode: "vertical-lr", direction: "rtl" }}
          />
          <span className="text-[10px] tracking-[0.2em] text-text-tertiary">B</span>
        </div>

        <Deck
          side="B"
          state={decks.b}
          gain={deckGain(crossfade, "b", decks.b.trim)}
          onPlay={() => void toggle("b")}
          onPause={() => void toggle("b")}
          onSeek={(ms) => {
            const element = audioRef.current.b;
            if (element) element.currentTime = ms / 1000;
          }}
          onTrim={(trim) => setDecks((prev) => ({ ...prev, b: { ...prev.b, trim } }))}
          onTempo={(tempo) => {
            setDecks((prev) => ({ ...prev, b: { ...prev.b, tempo } }));
            const element = audioRef.current.b;
            if (element) element.playbackRate = tempoToRate(tempo);
          }}
        />
      </div>

      <audio ref={(el) => void (audioRef.current.a = el)} preload="auto" />
      <audio ref={(el) => void (audioRef.current.b = el)} preload="auto" />
    </div>
  );
}

export default memo(DjSurface);
