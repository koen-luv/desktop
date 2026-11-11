import { memo, useEffect, useRef } from "react";
import { columnForPosition, positionForColumn, type WaveformPeaks } from "./waveform";

/**
 * Deck waveform (Deere-style overview).
 *
 * Decodes the track once, reduces it to min/max columns, then paints played and
 * remaining halves in different colours with a playhead. Clicking seeks, which
 * is how the Mixxx overview strip behaves.
 *
 * Decoding needs the raw bytes, so a stream the browser may not fetch (CORS)
 * simply shows the placeholder instead of failing the deck.
 */

interface WaveformProps {
  /** Peaks computed by the deck (shared with BPM analysis, decoded once). */
  peaks: WaveformPeaks | null;
  status: "idle" | "ready" | "unavailable";
  positionMs: number;
  durationMs: number;
  /** Beatgrid for the vertical tick overlay. */
  grid: { bpm: number; anchorMs: number } | null;
  onSeek: (ms: number) => void;
  label: string;
}

const COLUMNS = 900;

function Waveform({ peaks: peaksProp, status, positionMs, durationMs, grid, onSeek, label }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<WaveformPeaks | null>(peaksProp);
  peaksRef.current = peaksProp;

  // Paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || COLUMNS;
    const height = canvas.clientHeight || 64;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const peaks = peaksRef.current;
    const mid = height / 2;
    const playheadX = (columnForPosition(positionMs, durationMs, width) / Math.max(1, width - 1)) * width;

    if (!peaks) {
      context.fillStyle = "rgba(255,255,255,0.10)";
      context.fillRect(0, mid - 0.5, width, 1);
      return;
    }

    const step = peaks.min.length / width;
    for (let column = 0; column < width; column += 1) {
      const index = Math.min(peaks.min.length - 1, Math.floor(column * step));
      const low = peaks.min[index];
      const high = peaks.max[index];
      const top = mid - high * mid * 0.92;
      const bottom = mid - low * mid * 0.92;
      // Played part is bright, the rest dim: the same read Mixxx gives at a
      // glance while mixing.
      context.fillStyle = column <= playheadX ? "#8f79ff" : "rgba(255,255,255,0.34)";
      context.fillRect(column, top, 1, Math.max(1, bottom - top));
    }

    if (grid && durationMs > 0) {
      const beat = 60_000 / grid.bpm;
      context.fillStyle = "rgba(255,255,255,0.22)";
      for (let t = grid.anchorMs % beat; t < durationMs; t += beat) {
        const x = Math.round((t / durationMs) * width);
        context.fillRect(x, 0, 1, height);
      }
    }

    context.fillStyle = "#f4f3f8";
    context.fillRect(Math.round(playheadX), 0, 1, height);
  }, [positionMs, durationMs, status, grid]);

  const seekFromEvent = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = ((event.clientX - rect.left) / rect.width) * (COLUMNS - 1);
    onSeek(positionForColumn(column, durationMs, COLUMNS));
  };

  return (
    <div className="relative h-[64px] w-full overflow-hidden rounded-[10px] bg-black/40">
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
