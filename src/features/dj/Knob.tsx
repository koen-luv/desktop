import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  angleForNormalized,
  isBipolar,
  normalizedFromValue,
  snapToStep,
  valueFromDrag,
} from "./knobMath";

/**
 * Rotary DJ knob.
 *
 * Pointer-drag (vertical, like a hardware encoder), wheel, arrows, PageUp/Down,
 * Home/End, and double-click to return to the resting value. The value arc is
 * drawn from the default, so EQ knobs read from centre and FX sends read from
 * zero. Exposed to assistive tech as a slider with live values.
 */

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Resting value for double-click reset and the arc origin. */
  defaultValue?: number;
  /** Format the readout; default rounds to two decimals. */
  format?: (value: number) => string;
  /** Sensitivity: pixels of drag for the full range. */
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
  size = 34,
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
    commit(valueFromDrag(drag.startValue, event.clientY - drag.startY, min, max, travel, event.shiftKey));
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

  // Arc geometry: 270° sweep from −135° to +135°.
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
    <div className="dj-knob shrink-0">
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
        className={`relative cursor-ns-resize rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--dj-led-amber)]/70 touch-none ${
          dragging ? "ring-2 ring-[var(--dj-led-amber)]/50" : ""
        }`}
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          {/* track */}
          <path
            className="track"
            d={arc(0, 1)}
            fill="none"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          {/* value, from the resting position */}
          {Math.abs(normalized - restNormalized) > 0.001 && (
            <path
              d={arc(restNormalized, normalized)}
              fill="none"
              stroke={bipolar ? "#ffb020" : "#2dd4a8"}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
          )}
          {/* cap */}
          <circle className="cap" cx={center} cy={center} r={radius - 3.5} />
          {/* needle */}
          <g transform={`rotate(${needleAngle} ${center} ${center})`}>
            <line className="needle" x1={center} y1={center - radius + 5} x2={center} y2={center - 4} strokeWidth={2} strokeLinecap="round" />
          </g>
        </svg>
      </div>
      <span className="dj-label">{label}</span>
      <span className={`dj-value ${dragging ? "text-text-primary" : ""}`}>
        {format ? format(value) : value.toFixed(2)}
      </span>
    </div>
  );
});

export default Knob;
