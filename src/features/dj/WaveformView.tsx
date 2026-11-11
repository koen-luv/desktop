import { memo, useEffect, useRef } from "react";
import { columnForPosition, positionForColumn, type WaveformPeaks } from "./waveform";

/**
 * Deck waveform strip.
 *
 * Drawn with the app's own colours: the played portion is the accent (like the
 * mini player's progress fill), the rest is muted text, the beatgrid is a
 * hairline border. Deck identity comes from the accent variant — primary for
 * A, secondary for B — so the two strips are distinguishable without importing
 * a colour that isn't already in the product's palette.
 */

interface WaveformProps {
  peaks: WaveformPeaks | null;
  status: "idle" | "ready" | "unavailable";
  positionMs: number;
  durationMs: number;
  grid: { bpm: number; anchorMs: number } | null;
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
  height = 72,
  onSeek,
  label,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    // Resolve the app's token colours once per paint so theme changes apply.
    const styles = getComputedStyle(canvas);
    const read = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    const played = hue === "a" ? read("--accent-primary", "#6d4aff") : read("--accent-secondary", "#8b6bff");
    const unplayed = hue === "a" ? "rgba(109,74,255,0.28)" : "rgba(139,107,255,0.28)";
    const gridColor = read("--border-secondary", "#d5d3ce");
    const playhead = read("--accent-primary", "#6d4aff");

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || COLUMNS;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const peaks = peaksProp;
    const mid = height / 2;
    const playheadX =
      (columnForPosition(positionMs, durationMs, width) / Math.max(1, width - 1)) * width;

    if (!peaks) {
      context.fillStyle = "rgba(128,128,128,0.18)";
      context.fillRect(0, mid - 0.5, width, 1);
      return;
    }

    if (grid && durationMs > 0 && grid.bpm > 0) {
      const beat = 60_000 / grid.bpm;
      context.fillStyle = gridColor;
      context.globalAlpha = 0.35;
      for (let t = grid.anchorMs % beat; t < durationMs; t += beat) {
        const x = Math.round((t / durationMs) * width);
        context.fillRect(x, 0, 1, height);
      }
      context.globalAlpha = 1;
    }

    const step = peaks.min.length / width;
    for (let column = 0; column < width; column += 1) {
      const index = Math.min(peaks.min.length - 1, Math.floor(column * step));
      const low = peaks.min[index];
      const high = peaks.max[index];
      const top = mid - high * mid * 0.9;
      const bottom = mid - low * mid * 0.9;
      context.fillStyle = column <= playheadX ? played : unplayed;
      context.fillRect(column, top, 1, Math.max(1, bottom - top));
    }

    context.fillStyle = playhead;
    context.fillRect(Math.round(playheadX), 0, 1.5, height);
  }, [positionMs, durationMs, status, grid, peaksProp, hue, height]);

  const seekFromEvent = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = ((event.clientX - rect.left) / rect.width) * (COLUMNS - 1);
    onSeek(positionForColumn(column, durationMs, COLUMNS));
  };

  return (
    <div
      className="relative overflow-hidden rounded-[12px] bg-bg-panel"
      style={{ height }}
    >
      <canvas
        ref={canvasRef}
        aria-label={`${label} waveform`}
        onClick={seekFromEvent}
        className="h-full w-full cursor-crosshair"
      />
      {status === "unavailable" && (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] text-text-tertiary">
          waveform unavailable for this stream
        </span>
      )}
    </div>
  );
}

export default memo(Waveform);
