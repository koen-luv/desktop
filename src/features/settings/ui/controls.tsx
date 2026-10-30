import type { ReactNode } from "react";
import { getTranslationsForAllLocales } from "@/languages";

const font = { fontFamily: "var(--font-inter), sans-serif" } as const;

// single-line row: label on the left, control pinned right, like the reference mock
export function SettingRow({
  title,
  description,
  control,
  titleKey,
  descKey,
  searchQuery,
}: {
  title: string;
  description?: string;
  control?: ReactNode;
  titleKey?: string;
  descKey?: string;
  searchQuery?: string;
}) {
  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    let isMatch =
      title.toLowerCase().includes(q) ||
      (description ? description.toLowerCase().includes(q) : false);

    if (!isMatch && (titleKey || descKey)) {
      const allTexts: string[] = [];
      if (titleKey) allTexts.push(...getTranslationsForAllLocales(titleKey));
      if (descKey) allTexts.push(...getTranslationsForAllLocales(descKey));
      isMatch = allTexts.some((text) => text.toLowerCase().includes(q));
    }

    if (!isMatch) return null;
  }

  return (
    // Narrow (phone) widths stack the control under its label so wide pill
    // groups never squeeze the description into a sliver of text.
    <div className="flex flex-col items-start gap-[10px] py-[14px] sm:flex-row sm:items-center sm:justify-between sm:gap-[16px]">
      <div className="flex w-full min-w-0 max-w-[360px] flex-col gap-[2px] sm:w-auto">
        <span
          className="text-text-primary text-[13px] font-[500] leading-snug tracking-[-0.006em]"
          style={font}
        >
          {title}
        </span>
        {description ? (
        <span
          className="text-text-tertiary text-[12.5px] leading-relaxed"
          style={font}
        >
            {description}
          </span>
        ) : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}

// stacked block: label on top, wide control (cards, grids) below
export function SettingBlock({
  title,
  description,
  children,
  titleKey,
  descKey,
  searchQuery,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  titleKey?: string;
  descKey?: string;
  searchQuery?: string;
}) {
  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    let isMatch =
      title.toLowerCase().includes(q) ||
      (description ? description.toLowerCase().includes(q) : false);

    if (!isMatch && (titleKey || descKey)) {
      const allTexts: string[] = [];
      if (titleKey) allTexts.push(...getTranslationsForAllLocales(titleKey));
      if (descKey) allTexts.push(...getTranslationsForAllLocales(descKey));
      isMatch = allTexts.some((text) => text.toLowerCase().includes(q));
    }

    if (!isMatch) return null;
  }

  return (
    <div className="flex flex-col gap-[10px] py-[14px]">
      <div className="flex min-w-0 max-w-[460px] flex-col gap-[2px]">
        <span
          className="text-text-primary text-[13px] font-[500] leading-snug tracking-[-0.006em]"
          style={font}
        >
          {title}
        </span>
        {description ? (
        <span
          className="text-text-tertiary text-[12.5px] leading-relaxed"
          style={font}
        >
            {description}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// faint uppercase group label, keeps long tabs scannable without extra prose
export function SettingSection({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      {label ? (
        <h4
          className="text-text-tertiary text-[10.5px] font-[600] uppercase tracking-[0.08em] m-0 pb-[6px] pt-[6px]"
          style={font}
        >
          {label}
        </h4>
      ) : null}
      <div className="flex flex-col divide-y divide-solid divide-border-primary">
        {children}
      </div>
    </section>
  );
}

// compact pill switcher reused by language / playback / mini-player rows
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div
      role={ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
      className={`inline-flex w-fit shrink-0 items-center gap-[2px] rounded-lg p-[3px] transition-opacity shadow-[inset_0_0_0_1px_var(--border-primary)] ${
        disabled
          ? "bg-bg-hover opacity-50 cursor-not-allowed pointer-events-none"
          : "bg-bg-hover"
      }`}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && onChange(opt.value)}
            aria-pressed={isActive}
            className={`inline-flex h-[26px] items-center whitespace-nowrap rounded-md border-0 px-[11px] text-[12.5px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 ${
              disabled
                ? isActive
                  ? "bg-bg-active text-text-tertiary cursor-not-allowed"
                  : "bg-transparent text-text-tertiary/70 cursor-not-allowed"
                : isActive
                  ? "bg-btn-primary-bg text-btn-primary-text shadow-e1 cursor-pointer"
                  : "bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
            }`}
            style={{ ...font, fontWeight: isActive ? 500 : 450 }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
