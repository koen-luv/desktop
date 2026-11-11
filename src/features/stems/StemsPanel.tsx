import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CHANNELS, type StemChannel } from "./mix";
import { formatDeckTime } from "@/features/dj/mixMath";
import { StemEngine, toLoadedStems } from "./engine";
import {
  StemsUnavailableError,
  isStemSeparationAvailable,
  separateStems,
  type Stem,
  type StemName,
} from "./api";
import { resolvePlaybackStream } from "@/features/player/engine/playbackSource";
import type { NeritiumElectronApi } from "../../../electron/preload";
import type { Track } from "@/shared/types";
import { log } from "@/shared/utils/logger";

/**
 * Stem mixer panel.
 *
 * Flow: ask the backend for stems → cache them locally through the main process
 * (downloaded once per track) → play four media elements through one AudioContext
 * with per-stem gain. Mute/solo come from the tested `mix.ts` rules.
 *
 * When the deployment has no separation service the panel says exactly that
 * instead of showing a mixer that cannot do anything.
 */

interface StemsPanelProps {
  track: Track | null;
  onClose: () => void;
}

const LABELS: Record<StemChannel["name"], string> = {
  vocals: "Vocals",
  drums: "Drums",
  bass: "Bass",
  other: "Other",
};

function StemsPanel({ track, onClose }: StemsPanelProps) {
  const engineRef = useRef(new StemEngine());
  const [channels, setChannels] = useState<StemChannel[]>(DEFAULT_CHANNELS);
  const [stems, setStems] = useState<Stem[]>([]);
  const [phase, setPhase] = useState<"checking" | "unavailable" | "working" | "ready" | "error">(
    "checking",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [cacheNote, setCacheNote] = useState<string | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);

  const engine = engineRef.current;

  const prepare = useCallback(async () => {
    if (!track) return;
    setPhase("checking");
    setMessage(null);

    const bridge = window.neritiumElectron;

    // Desktop: Demucs runs through the main process and the stems are cached on
    // disk, so no worker availability check is involved.
    if (bridge?.stemsSeparate) {
      setPhase("working");
      setMessage("Separating stems — the first run takes a minute or two…");
      try {
        const stream = await resolvePlaybackStream(track);
        if (!stream.url) throw new Error("No playable stream to separate");
        const result = await bridge.stemsSeparate(track.id, stream.url);
        if (!result.ok) throw new Error(result.error);
        engine.load(result.stems.map((stem) => ({ name: stem.name as StemName, src: stem.path })));
        engine.subscribe((position, duration) => {
          setPositionMs(position);
          setDurationMs(duration);
        });
        engine.apply(DEFAULT_CHANNELS);
        setChannels(DEFAULT_CHANNELS);
        setCacheNote(`Cached on disk — replaying this track will not separate again.`);
        setPhase("ready");
        setMessage(null);
      } catch (error) {
        log("red", "stems", `demucs separation failed: ${String(error)}`);
        setPhase("error");
        setMessage(error instanceof Error ? error.message : "Stem separation failed.");
      }
      return;
    }

    if (!(await isStemSeparationAvailable())) {
      setPhase("unavailable");
      setMessage(
        "This server has no stem separation configured. Point STEMS_SERVICE_URL at a Demucs service to enable it.",
      );
      return;
    }

    setPhase("working");
    setMessage("Separating stems — this can take a minute on the first run…");
    try {
      // The service needs a URL it can fetch; reuse the normal resolver.
      const stream = await resolvePlaybackStream(track);
      if (!stream.url) throw new Error("No playable stream to separate");
      const result = await separateStems(track.id, stream.url);
      setStems(result.stems);

      let cached: { name: string; path: string }[] = [];
      if (bridge?.stemsEnsure) {
        const ensured = await bridge.stemsEnsure(
          track.id,
          result.stems.map((stem) => ({ name: stem.name, url: stem.url })),
        );
        if (ensured.ok) {
          cached = ensured.stems;
          setCacheNote(
            ensured.downloaded.length > 0
              ? `Saved ${ensured.downloaded.length} stem${ensured.downloaded.length === 1 ? "" : "s"} for offline reuse.`
              : "Using stems cached on disk.",
          );
        } else {
          log("yellow", "stems", `caching failed: ${ensured.error}`);
          setCacheNote("Playing stems from the service — they could not be cached.");
        }
      }

      engine.load(toLoadedStems(result.stems, cached));
      engine.subscribe((position, duration) => {
        setPositionMs(position);
        setDurationMs(duration);
      });
      engine.apply(DEFAULT_CHANNELS);
      setChannels(DEFAULT_CHANNELS);
      setPhase("ready");
      setMessage(null);
    } catch (error) {
      if (error instanceof StemsUnavailableError) {
        setPhase("unavailable");
        setMessage(error.message);
        return;
      }
      log("red", "stems", `separation failed: ${String(error)}`);
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Stem separation failed.");
    }
  }, [engine, track]);

  useEffect(() => {
    void prepare();
    return () => engine.dispose();
  }, [engine, prepare]);

  const updateChannels = useCallback(
    (next: StemChannel[]) => {
      setChannels(next);
      engine.apply(next);
    },
    [engine],
  );

  const togglePlay = useCallback(async () => {
    if (engine.isPlaying) {
      engine.pause();
      setPlaying(false);
    } else {
      await engine.play(positionMs);
      setPlaying(true);
    }
  }, [engine, positionMs]);

  const header = useMemo(() => {
    if (!track) return "No track";
    return `${track.title} — ${track.artists}`;
  }, [track]);

  return (
    <div className="absolute inset-0 z-[96] flex flex-col gap-3 bg-bg-primary/98 p-4 backdrop-blur-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-[11px] tracking-[0.2em] text-text-tertiary">STEMS</p>
          <p className="m-0 truncate text-[14px] font-[600] text-text-primary">{header}</p>
          {cacheNote ? (
            <p className="m-0 mt-1 text-[11px] text-text-tertiary">{cacheNote}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => {
            engine.dispose();
            onClose();
          }}
          className="h-[32px] shrink-0 rounded-[10px] border border-border-primary px-3 text-[12px]"
        >
          Close
        </button>
      </div>

      {phase !== "ready" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="m-0 max-w-[420px] text-[13px] text-text-secondary">{message}</p>
          {phase === "working" ? (
            <span className="h-[16px] w-[16px] animate-spin rounded-full border-2 border-text-tertiary border-t-transparent" />
          ) : null}
          {phase === "error" ? (
            <button
              type="button"
              onClick={() => void prepare()}
              className="h-[32px] rounded-[10px] border border-border-primary px-3 text-[12px]"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void togglePlay()}
              className="h-[36px] min-w-[88px] rounded-[10px] border-0 bg-accent-primary px-4 text-[13px] font-[600] text-accent-ink"
            >
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              aria-label="Stem position"
              min={0}
              max={Math.max(1, durationMs)}
              value={positionMs}
              onChange={(event) => {
                const next = Number(event.target.value);
                engine.seek(next);
                setPositionMs(next);
              }}
              className="w-full accent-accent-primary"
            />
            <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
              {formatDeckTime(positionMs)} / {formatDeckTime(durationMs)}
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {channels.map((channel, index) => (
              <div
                key={channel.name}
                className="flex items-center gap-3 rounded-[12px] border border-border-primary/50 px-3 py-2"
              >
                <span className="w-[58px] shrink-0 text-[12px] font-[500] text-text-primary">
                  {LABELS[channel.name]}
                </span>
                <input
                  type="range"
                  aria-label={`${LABELS[channel.name]} level`}
                  min={0}
                  max={1}
                  step={0.01}
                  value={channel.level}
                  onChange={(event) => {
                    const next = [...channels];
                    next[index] = { ...channel, level: Number(event.target.value) };
                    updateChannels(next);
                  }}
                  className="flex-1 accent-accent-primary"
                />
                <button
                  type="button"
                  aria-pressed={channel.muted}
                  aria-label={`Mute ${LABELS[channel.name]}`}
                  onClick={() => {
                    const next = [...channels];
                    next[index] = { ...channel, muted: !channel.muted };
                    updateChannels(next);
                  }}
                  className={`h-[26px] w-[30px] rounded-[8px] text-[11px] font-[600] ${
                    channel.muted
                      ? "bg-red-500/80 text-white"
                      : "border border-border-primary text-text-secondary"
                  }`}
                >
                  M
                </button>
                <button
                  type="button"
                  aria-pressed={channel.solo}
                  aria-label={`Solo ${LABELS[channel.name]}`}
                  onClick={() => {
                    const next = [...channels];
                    next[index] = { ...channel, solo: !channel.solo };
                    updateChannels(next);
                  }}
                  className={`h-[26px] w-[30px] rounded-[8px] text-[11px] font-[600] ${
                    channel.solo
                      ? "bg-accent-primary text-accent-ink"
                      : "border border-border-primary text-text-secondary"
                  }`}
                >
                  S
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {phase === "ready" && stems.length > 0 ? (
        <p className="m-0 text-[10px] text-text-tertiary">
          {stems.length} stems · mute and solo apply to the mix, not the files.
        </p>
      ) : null}
    </div>
  );
}

export default memo(StemsPanel);
