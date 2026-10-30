import { motion } from "framer-motion";
import type { LibraryTab } from "../types";
import { useTranslation } from "@/languages";
import { useIsContentTransparent } from "@/features/settings/store/customizationStore";

interface LibraryTabsProps {
  activeTab: LibraryTab;
  onChange: (tab: LibraryTab) => void;
}

const tabs: LibraryTab[] = ["playlists", "albums", "artists"];

export default function LibraryTabs({
  activeTab,
  onChange,
}: LibraryTabsProps) {
  const { t } = useTranslation();
  const hasCustomBg = useIsContentTransparent();

  const tabLabels: Record<LibraryTab, string> = {
    playlists: t("library.tab_playlists"),
    albums: t("library.tab_albums"),
    artists: t("library.tab_artists"),
  };

  return (
    <div
      className={`inline-flex items-center gap-[2px] rounded-full p-[3px] ${
        hasCustomBg
          ? "apple-glass-pill"
          : "bg-bg-elevated shadow-[inset_0_0_0_1px_var(--border-primary)]"
      }`}
    >
      {tabs.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => onChange(tab)}
            className={`relative inline-flex items-center justify-center rounded-full px-[16px] h-[30px] text-[12.5px] leading-none transition-colors duration-150 border-0 bg-transparent cursor-pointer select-none active:scale-[0.97] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-soft ${
              isActive
                ? hasCustomBg
                  ? "text-white dark:text-black font-semibold"
                  : "text-btn-primary-text"
                : hasCustomBg
                  ? "text-black/70 dark:text-white/70 hover:text-black dark:hover:text-white"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
            style={{
              fontFamily: "var(--font-inter), sans-serif",
              fontWeight: isActive ? 500 : 450,
              letterSpacing: "-0.006em",
            }}
          >
            {isActive && (
              <motion.div
                layoutId="activeLibraryTab"
                className={`absolute inset-0 rounded-full ${
                  hasCustomBg
                    ? "apple-glass-prominent"
                    : "bg-btn-primary-bg shadow-[0_6px_16px_-8px_var(--btn-primary-bg)]"
                }`}
                transition={{
                  type: "spring",
                  stiffness: 450,
                  damping: 35,
                }}
              />
            )}
            <span className="relative z-10">{tabLabels[tab]}</span>
          </button>
        );
      })}
    </div>
  );
}
