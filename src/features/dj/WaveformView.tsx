import { memo, useEffect, useRef } from "react";
import { columnForPosition, positionForColumn, type WaveformPeaks } from "./waveform";

/**
 * Deck waveform strip (booth overview).
 *
 * The signature element of the DJ surface: the track's shape, chroma-coded to
 * the deck (teal A, magenta B) so a glance at the ribbon tells you which deck
 * is doing what. The beatgrid draws as tick marks over it and the playhead is
 * amber, the one warm signal on a cold panel — colour here is state, not
 * decoration.
 */

interface WaveformProps {
  /** Peaks computed by the deck (shared with BPM analysis, decoded once). */
  peaks: WaveformPeaks | null;
  status: "idle" | "ready" | "unavailable";
  positionMs: number;
  durationMs: number;
  /** Beatgrid for the vertical tick overlay. */
  grid: { bpm: number; anchorMs: number } | null;
  /** Chroma identity of the deck. */
  hue: "a" | "b";
  height?: number;
  onSeek: (ms: number) => void;
  label: string;
}

const COLUMNS = 900;

function Waveform({
  peaks: peaksProp,
  status,
  positionMs,
  durationMs,
  grid,
  hue,
  height = 84,
  onSeek,
  label,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || COLUMNS;
    const canvasHeight = height;
    if (canvas.width !== width * dpr || canvas.height !== canvasHeight * dpr) {
      canvas.width = width * dpr;
      canvas.height = canvasHeight * dpr;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, canvasHeight);

    const peaks = peaksProp;
    const mid = canvasHeight / 2;
    const playheadX =
      (columnForPosition(positionMs, durationMs, width) / Math.max(1, width - 1)) * width;

    if (!peaks) {
      context.fillStyle = "rgba(255,255,255,0.10)";
      context.fillRect(0, mid - 0.5, width, 1);
      return;
    }

    const on = hue === "a" ? "#2dd4a8" : "#e879f9";
    const off = hue === "a" ? "rgba(45,212,168,0.30)" : "rgba(232,121,249,0.30)";

    // Beat grid first, so the waveform sits on top of the ticks.
    if (grid && durationMs > 0 && grid.bpm > 0) {
      const beat = 60_000 / grid.bpm;
      context.fillStyle = "rgba(255,255,255,0.16)";
      for (let t = grid.anchorMs % beat; t < durationMs; t += beat) {
        const x = Math.round((t / durationMs) * width);
        context.fillRect(x, 0, 1, canvasHeight);
      }
    }

    const step = peaks.min.length / width;
    for (let column = 0; column < width; column += 1) {
      const index = Math.min(peaks.min.length - 1, Math.floor(column * step));
      const low = peaks.min[index];
      const high = peaks.max[index];
      const top = mid - high * mid * 0.92;
      const bottom = mid - low * mid * 0.92;
      // Played is full chroma, the rest is the same hue dimmed: the deck stays
      // identifiable at a glance whether or not it is playing.
      context.fillStyle = column <= playheadX ? on : off;
      context.fillRect(column, top, 1, Math.max(1, bottom - top));
    }

    // Playhead: the one warm signal on the panel.
    context.fillStyle = "#ffb020";
    context.fillRect(Math.round(playheadX), 0, 1.5, canvasHeight);
    context.fillStyle = "rgba(255,176,32,0.22)";
    context.fillRect(Math.round(playheadX) - 2, 0, 5.5, canvasHeight);
  }, [positionMs, durationMs, status, grid, peaksProp, hue, height]);

  const seekFromEvent = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = ((event.clientX - rect.left) / rect.width) * (COLUMNS - 1);
    onSeek(positionForColumn(column, durationMs, COLUMNS));
  };

  return (
    <div className="dj-ribbon relative" style={{ height }}>
      <canvas
        ref={canvasRef}
        aria-label={`${label} waveform`}
        onClick={seekFromEvent}
        className="h-full w-full cursor-crosshair"
      />
      {status === "unavailable" && (
        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-text-tertiary">
          waveform unavailable for this stream
        </span>
      )}
    </div>
  );
}

export default memo(Waveform);
