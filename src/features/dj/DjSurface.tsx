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
  focused,
  canSync,
  onFocus,
  onPlay,
  onPause,
  onCue,
  onSync,
  onSeek,
  onTrim,
  onTempo,
  onNudge,
}: {
  side: "A" | "B";
  state: DeckState;
  gain: number;
  focused: boolean;
  canSync: boolean;
  onFocus: () => void;
  onPlay: () => void;
  onPause: () => void;
  onCue: () => void;
  onSync: () => void;
  onSeek: (ms: number) => void;
  onTrim: (value: number) => void;
  onTempo: (value: number) => void;
  onNudge: (deltaMs: number) => void;
}) {
  return (
    <div
      onClick={onFocus}
      className={`flex min-w-0 flex-1 flex-col gap-3 rounded-[16px] border p-4 transition-colors ${
        focused
          ? "border-accent-primary/70 bg-bg-panel"
          : "border-border-primary/60 bg-bg-panel/80"
      }`}
    >
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
          className="h-[38px] min-w-[76px] rounded-[10px] border-0 bg-accent-primary px-3 text-[13px] font-[600] text-accent-ink disabled:opacity-40"
        >
          {state.loading ? "…" : state.playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={onCue}
          disabled={!state.track}
          className="h-[38px] w-[52px] rounded-[10px] border border-border-primary text-[12px] font-[600] text-text-primary disabled:opacity-40"
        >
          Cue
        </button>
        <button
          type="button"
          onClick={onSync}
          disabled={!canSync}
          className="h-[38px] w-[52px] rounded-[10px] border border-border-primary text-[12px] font-[600] text-text-secondary disabled:opacity-40"
        >
          Sync
        </button>
        <button
          type="button"
          onClick={() => onNudge(-500)}
          disabled={!state.track}
          aria-label={`Deck ${side} back half second`}
          className="h-[38px] w-[36px] rounded-[10px] border border-border-primary text-[12px] text-text-secondary disabled:opacity-40"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => onNudge(500)}
          disabled={!state.track}
          aria-label={`Deck ${side} forward half second`}
          className="h-[38px] w-[36px] rounded-[10px] border border-border-primary text-[12px] text-text-secondary disabled:opacity-40"
        >
          +
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
  const [master, setMaster] = useState(1);
  const [focused, setFocused] = useState<"a" | "b">("a");
  const [query, setQuery] = useState("");
  const masterGainRef = useRef<GainNode | null>(null);
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
    const masterGain = ctx.createGain();
    masterGain.gain.value = master;
    masterGain.connect(ctx.destination);
    ctx.createMediaElementSource(a).connect(gainA).connect(masterGain);
    ctx.createMediaElementSource(b).connect(gainB).connect(masterGain);
    masterGainRef.current = masterGain;
    gainsRef.current = { ctx, a: gainA, b: gainB };
    return gainsRef.current;
  }, []);

  // Apply fader + trim + master continuously.
  useEffect(() => {
    const graph = ensureGraph();
    if (!graph) return;
    graph.a.gain.value = deckGain(crossfade, "a", decks.a.trim);
    graph.b.gain.value = deckGain(crossfade, "b", decks.b.trim);
    if (masterGainRef.current) masterGainRef.current.gain.value = master;
  }, [crossfade, decks.a.trim, decks.b.trim, master, ensureGraph]);

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

  const cue = useCallback(
    (side: "a" | "b") => {
      const element = audioRef.current[side];
      if (!element) return;
      element.pause();
      element.currentTime = 0;
      setDecks((prev) => ({ ...prev, [side]: { ...prev[side], playing: false, positionMs: 0 } }));
    },
    [],
  );

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
        <div className="flex w-[240px] shrink-0 flex-col gap-2 rounded-[16px] border border-border-primary/60 bg-bg-panel/70 p-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the queue…"
            aria-label="Search tracks for the decks"
            className="h-[32px] w-full rounded-[10px] border border-border-primary bg-transparent px-3 text-[12px] text-text-primary outline-none"
          />
          <p className="m-0 text-[10px] tracking-[0.16em] text-text-tertiary">
            LOADING TO DECK {focused.toUpperCase()}
          </p>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {library.length === 0 ? (
              <p className="m-0 text-[11px] text-text-tertiary">Nothing queued yet.</p>
            ) : (
              library.map((item) => (
                <button
                  key={`${item.id}-${item.title}`}
                  type="button"
                  onClick={() => void loadTrack(focused, item)}
                  className="flex flex-col items-start gap-[1px] rounded-[8px] px-2 py-[6px] text-left hover:bg-bg-hover"
                >
                  <span className="w-full truncate text-[12px] font-[500] text-text-primary">
                    {item.title}
                  </span>
                  <span className="w-full truncate text-[10px] text-text-tertiary">
                    {item.artists}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <Deck
          side="A"
          state={decks.a}
          gain={deckGain(crossfade, "a", decks.a.trim)}
          focused={focused === "a"}
          canSync={Boolean(decks.b.track)}
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
          <div className="mt-3 flex w-[46px] flex-col items-center gap-1">
            <span className="text-[9px] tracking-[0.12em] text-text-tertiary">MASTER</span>
            <input
              type="range"
              aria-label="Master volume"
              min={0}
              max={1}
              step={0.01}
              value={master}
              onChange={(event) => setMaster(Number(event.target.value))}
              className="w-full accent-accent-primary"
            />
          </div>
        </div>

        <Deck
          side="B"
          state={decks.b}
          gain={deckGain(crossfade, "b", decks.b.trim)}
          focused={focused === "b"}
          canSync={Boolean(decks.a.track)}
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
