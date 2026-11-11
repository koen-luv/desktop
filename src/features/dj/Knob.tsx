import { memo, useCallback, useRef, useState } from "react";
import {
  angleForNormalized,
  isBipolar,
  normalizedFromValue,
  snapToStep,
  valueFromDrag,
} from "./knobMath";

/**
 * Rotary knob.
 *
 * Pointer-drag (vertical), wheel, arrows, PageUp/Down, Home/End, double-click
 * to return to the resting value. Drawn with the app's own tokens — the arc is
 * the accent, the cap is a panel surface — so a knob reads as part of the same
 * product as every other control, not as hardware cosplay.
 */

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Resting value for double-click reset and the arc origin. */
  defaultValue?: number;
  format?: (value: number) => string;
  /** Drag distance in pixels for the full range. */
  travel?: number;
  size?: number;
  onChange: (value: number) => void;
}

const Knob = memo(function Knob({
  label,
  value,
  min,
  max,
  step = 0.01,
  defaultValue,
  format,
  travel = 160,
  size = 32,
  onChange,
}: KnobProps) {
  const rest = defaultValue ?? min;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
  const normalized = normalizedFromValue(value, min, max);
  const restNormalized = normalizedFromValue(rest, min, max);

  const commit = useCallback(
    (next: number) => {
      const snapped = snapToStep(Math.min(max, Math.max(min, next)), step);
      onChange(Number(snapped.toFixed(4)));
    },
    [max, min, onChange, step],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    dragRef.current = { startY: event.clientY, startValue: value };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    commit(
      valueFromDrag(drag.startValue, event.clientY - drag.startY, min, max, travel, event.shiftKey),
    );
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const big = step * 10;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") commit(value + (event.shiftKey ? big : step));
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") commit(value - (event.shiftKey ? big : step));
    else if (event.key === "PageUp") commit(value + big);
    else if (event.key === "PageDown") commit(value - big);
    else if (event.key === "Home") commit(min);
    else if (event.key === "End") commit(max);
    else return;
    event.preventDefault();
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    commit(value + (event.deltaY < 0 ? step : -step));
  };

  // 270° sweep from −135° to +135°.
  const radius = size / 2 - 3;
  const center = size / 2;
  const arc = (fromNorm: number, toNorm: number) => {
    const a0 = ((angleForNormalized(fromNorm) - 90) * Math.PI) / 180;
    const a1 = ((angleForNormalized(toNorm) - 90) * Math.PI) / 180;
    const large = Math.abs(toNorm - fromNorm) > 0.5 ? 1 : 0;
    const sweep = toNorm >= fromNorm ? 1 : 0;
    const x0 = center + radius * Math.cos(a0);
    const y0 = center + radius * Math.sin(a0);
    const x1 = center + radius * Math.cos(a1);
    const y1 = center + radius * Math.sin(a1);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };

  const bipolar = isBipolar(min, max, rest);
  const needleAngle = angleForNormalized(normalized);

  return (
    <div className="flex w-[42px] shrink-0 flex-col items-center gap-[3px]">
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format ? format(value) : String(value)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => commit(rest)}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        className={`relative cursor-ns-resize rounded-full touch-none outline-none focus-visible:ring-4 focus-visible:ring-accent-soft ${
          dragging ? "ring-4 ring-accent-soft" : ""
        }`}
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <path
            d={arc(0, 1)}
            fill="none"
            stroke="var(--border-primary)"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          {Math.abs(normalized - restNormalized) > 0.001 && (
            <path
              d={arc(restNormalized, normalized)}
              fill="none"
              stroke={bipolar ? "var(--accent-secondary)" : "var(--accent-primary)"}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
          )}
          <circle cx={center} cy={center} r={radius - 3.5} fill="var(--bg-panel)" />
          <g transform={`rotate(${needleAngle} ${center} ${center})`}>
            <line
              x1={center}
              y1={center - radius + 5}
              x2={center}
              y2={center - 4}
              stroke="var(--text-primary)"
              strokeWidth={2}
              strokeLinecap="round"
            />
          </g>
        </svg>
      </div>
      <span className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">{label}</span>
      <span className={`font-mono text-[10px] ${dragging ? "text-text-primary" : "text-text-secondary"}`}>
        {format ? format(value) : value.toFixed(2)}
      </span>
    </div>
  );
});

export default Knob;
