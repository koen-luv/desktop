import type { ReactNode } from "react";
import { ArrowLeftLine } from "@mingcute/react";

export const SIDEBAR_TITLE_CLASS =
  "m-0 text-[26px] font-[650] leading-[1.1] tracking-[-0.038em] text-text-primary line-clamp-2";

export const SIDEBAR_SUBTITLE_CLASS =
  "m-0 text-[12.5px] leading-[1.6] text-text-secondary line-clamp-3";

export interface EntitySidebarProps {
  cover: ReactNode;
  coverClassName?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  primaryAction?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
}

export function EntitySidebar({
  cover,
  coverClassName,
  title,
  subtitle,
  meta,
  primaryAction,
  actions,
  onBack,
  backLabel = "Back",
}: EntitySidebarProps) {
  return (
    <aside className="md:sticky md:top-[20px] w-full max-w-[280px] md:w-[280px] shrink-0 self-start" data-no-window-drag>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-[30px] cursor-pointer items-center gap-[6px] rounded-full border-0 bg-transparent px-[10px] ml-[-10px] text-[12.5px] font-[500] tracking-[-0.006em] text-text-tertiary transition-colors duration-200 hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-soft"
          style={{ fontFamily: "var(--font-inter), sans-serif" }}
        >
          <ArrowLeftLine size={16} />
          <span className="relative -left-[1.5px] top-[1px]">{backLabel}</span>
        </button>
      )}

      <div
        className={`relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-[24px] ring-1 ring-border-primary shadow-e2 ${
          coverClassName || "bg-bg-panel"
        } ${onBack ? "mt-[18px]" : ""}`}
      >
        {cover}
      </div>

      <div
        className="mt-[18px] min-w-0"
        style={{ fontFamily: "var(--font-inter), sans-serif" }}
      >
        {title}
      </div>

      {subtitle && (
        <div
          className="mt-[6px]"
          style={{ fontFamily: "var(--font-inter), sans-serif" }}
        >
          {subtitle}
        </div>
      )}

      {meta && (
        <div
          className="m-0 mt-[8px] text-[12px] leading-[1.4] text-text-tertiary"
          style={{ fontFamily: "var(--font-inter), sans-serif", fontWeight: 400 }}
        >
          {meta}
        </div>
      )}

      {primaryAction && <div className="mt-[18px]">{primaryAction}</div>}

      {actions && (
        <div className="mt-[8px] flex items-center gap-[8px]">{actions}</div>
      )}
    </aside>
  );
}

export default EntitySidebar;
