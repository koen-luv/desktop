import { useState, useRef, useCallback, memo } from "react";
import { motion } from "framer-motion";

export interface SliderProps {
  label?: React.ReactNode;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
  className?: string;
  showValue?: boolean;
  disabled?: boolean;
}

export const Slider = memo(function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  unit = "",
  formatValue,
  ariaLabel,
  className = "",
  showValue = true,
  disabled = false,
}: SliderProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const currentValue = isDragging && dragValue !== null ? dragValue : value;
  const clampedValue = Math.max(min, Math.min(max, currentValue));
  const range = max - min || 1;
  const percentage = Math.max(0, Math.min(100, ((clampedValue - min) / range) * 100));

  const roundToStep = useCallback(
    (val: number): number => {
      const stepped = Math.round((val - min) / step) * step + min;
      const precision = step.toString().split(".")[1]?.length || 0;
      const rounded = Number(stepped.toFixed(precision));
      return Math.max(min, Math.min(max, rounded));
    },
    [min, max, step],
  );

  const updateValue = useCallback(
    (raw: number) => {
      if (disabled) return;
      const stepped = roundToStep(raw);
      onChange(stepped);
    },
    [disabled, onChange, roundToStep],
  );

  const calculateValueFromPointer = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return clampedValue;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const raw = min + ratio * (max - min);
      return roundToStep(raw);
    },
    [clampedValue, min, max, roundToStep],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

      const nextVal = calculateValueFromPointer(e.clientX);
      setDragValue(nextVal);
      updateValue(nextVal);

      const onPointerMove = (ev: PointerEvent) => {
        const val = calculateValueFromPointer(ev.clientX);
        setDragValue(val);
        updateValue(val);
      };

      const onPointerUp = (ev: PointerEvent) => {
        setIsDragging(false);
        setDragValue(null);
        try {
          (e.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
        } catch {}
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [calculateValueFromPointer, updateValue, disabled],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        updateValue(clampedValue + step);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        updateValue(clampedValue - step);
      } else if (e.key === "Home") {
        e.preventDefault();
        updateValue(min);
      } else if (e.key === "End") {
        e.preventDefault();
        updateValue(max);
      }
    },
    [clampedValue, step, min, max, updateValue, disabled],
  );

  const isActive = (isHovered || isDragging) && !disabled;
  const displayLabel = formatValue
    ? formatValue(clampedValue)
    : `${clampedValue}${unit}`;

  return (
    <div
      className={`group relative flex h-[28px] items-center gap-[12px] select-none ${
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
      } ${className}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {label && (
        <span className="text-[12px] font-[500] tracking-[-0.006em] text-text-secondary select-none">
          {label}
        </span>
      )}
      <div
        role="slider"
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clampedValue}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        className="relative flex h-full flex-1 items-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-accent-soft"
      >
        <motion.div
          ref={trackRef}
          initial={false}
          animate={{ scaleY: isActive ? 1.35 : 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 30, mass: 0.8 }}
          className={`relative h-[6px] w-full rounded-full origin-center bg-bg-active shadow-[inset_0_0_0_1px_var(--border-primary)] transition-colors duration-150`}
        >
          <div
            className={`absolute inset-y-0 left-0 rounded-full bg-accent-primary shadow-[0_0_12px_-2px_var(--accent-primary)] transition-[width] ease-out ${
              isDragging ? "duration-0" : "duration-100"
            }`}
            style={{ width: `${percentage}%` }}
          />
          <div
            className={`pointer-events-none absolute top-1/2 h-[14px] w-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_8px_rgba(23,21,29,0.35)] ring-1 ring-black/10 transition-transform duration-200 ease-[var(--motion-ease-emphasized)] ${
              isActive ? "scale-125" : "scale-100"
            }`}
            style={{ left: `${percentage}%` }}
            aria-hidden="true"
          />
        </motion.div>
      </div>

      {showValue && (
        <span
          className="w-[42px] shrink-0 text-right text-[12px] font-[500] tabular-nums text-text-tertiary group-hover:text-text-primary transition-colors"
          style={{ fontFamily: "var(--font-inter), sans-serif" }}
        >
          {displayLabel}
        </span>
      )}
    </div>
  );
});

export default Slider;
