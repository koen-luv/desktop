import { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeftLine } from "@mingcute/react";
import { useTranslation } from "@/languages";
import { useIsContentTransparent } from "@/features/settings/store/customizationStore";

export interface StickyHeaderProps {
  isScrolled: boolean;
  title?: string;
  thumbnail?: ReactNode;
  showBack?: boolean;
  onBack?: () => void;
  rightContent?: ReactNode;
  fallbackBackRoute?: string;
  className?: string;
}

export function StickyHeader({
  isScrolled,
  title,
  thumbnail,
  showBack = true,
  onBack,
  rightContent,
  fallbackBackRoute = "/library",
  className = "",
}: StickyHeaderProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const hasCustomBg = useIsContentTransparent();

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(fallbackBackRoute);
    }
  };

  const hasMetadata = Boolean(thumbnail || title);

  return (
    <div
      className={`sticky top-0 z-20 w-full pointer-events-none select-none ${className}`}
      style={{ height: "56px", marginBottom: "-56px" }}
      data-window-drag
    >
      <div className="relative flex items-center justify-between px-[32px] h-[56px] min-w-0">
        <div className="flex items-center gap-[8px] min-w-0">
          {showBack && (
            <button
              type="button"
              onClick={handleBack}
              aria-label={t("common.back")}
              data-no-tooltip="true"
              data-no-window-drag
              className={`group inline-flex h-[30px] shrink-0 items-center gap-[6px] rounded-lg px-[10px] active:scale-[0.95] transition-all cursor-pointer select-none pointer-events-auto text-[12.5px] font-[500] tracking-[-0.006em] border-0 !border-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/70 ${
                hasCustomBg
                  ? "apple-glass-pill !border-none"
                  : "bg-bg-panel/80 backdrop-blur-xl text-text-secondary hover:bg-bg-panel hover:text-text-primary border-0 !border-none"
              }`}
              style={{ fontFamily: "var(--font-inter), sans-serif" }}
            >
              <ArrowLeftLine
                size={16}
                className="transition-transform duration-150 group-hover:-translate-x-0.5"
              />
              <span className="relative -left-[1.5px] top-[1px]">{t("common.back")}</span>
            </button>
          )}

          {hasMetadata && (
            <div
              data-no-window-drag
              className={`inline-flex items-center gap-[8px] h-[30px] pl-[4px] pr-[12px] rounded-lg min-w-0 max-w-[calc(100vw-360px)] select-none transition-all duration-200 ease-out ${
                hasCustomBg
                  ? "apple-glass-pill"
                  : "bg-bg-panel/85 backdrop-blur-xl text-text-primary shadow-[inset_0_0_0_1px_var(--border-primary)]"
              } ${
                isScrolled
                  ? "opacity-100 translate-x-0 scale-100 pointer-events-auto"
                  : "opacity-0 -translate-x-2.5 scale-95 pointer-events-none"
              }`}
            >
              {thumbnail}

              {title && (
                <span
                  className="text-[12.5px] font-[600] tracking-[-0.012em] text-text-primary truncate"
                  style={{
                    fontFamily: "var(--font-inter), sans-serif",
                  }}
                >
                  {title}
                </span>
              )}
            </div>
          )}
        </div>

        {rightContent && (
          <div className="flex items-center gap-[8px] pointer-events-auto" data-no-window-drag>
            {rightContent}
          </div>
        )}
      </div>
    </div>
  );
}

export default StickyHeader;



