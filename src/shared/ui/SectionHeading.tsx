import type { ReactNode } from "react";

export interface SectionHeadingProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  className?: string;
}

/**
 * One heading rhythm for every content section (home rails, mixes, shelves).
 * The optional icon sits in a quiet tinted chip so colored glyphs read as
 * badges instead of competing with the title.
 */
export default function SectionHeading({
  title,
  subtitle,
  icon,
  badge,
  className = "",
}: SectionHeadingProps) {
  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <div className="flex min-w-0 items-center gap-[10px]">
        {icon && (
          <span
            aria-hidden="true"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-primary"
          >
            {icon}
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-[2px]">
          <div className="flex min-w-0 items-center gap-[8px]">
            <h2 className="m-0 truncate text-[20px] font-semibold leading-tight tracking-[-0.03em] text-text-primary">
              {title}
            </h2>
            {badge}
          </div>
          {subtitle && (
            <p className="m-0 truncate text-[12.5px] leading-tight text-text-tertiary">
              {subtitle}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
