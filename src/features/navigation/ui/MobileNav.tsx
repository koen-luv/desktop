import { memo } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  BookmarksFill,
  Home7Fill,
  Music2Fill,
  Search3Fill,
  Settings4Fill,
} from "@mingcute/react";
import { useTranslation } from "@/languages";
import { useModalStore } from "@/features/library";
import { usePlayerStore } from "@/features/player";
import { usePlayerState } from "@/features/player/hooks/usePlayerState";

interface MobileNavProps {
  searchOpen: boolean;
  onSearchToggle: () => void;
}

/**
 * Android phone/tablet bottom navigation. Mirrors the desktop sidebar feature
 * set (home, search, library, settings) and adds direct access to the
 * now-playing screen so the mobile layout never hides a feature.
 */
function MobileNav({ searchOpen, onSearchToggle }: MobileNavProps) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const settingsOpen = useModalStore((state) => state.settingsOpen);
  const toggleSettings = useModalStore((state) => state.toggleSettings);
  const setFullscreen = usePlayerStore((state) => state.setFullscreen);
  const player = usePlayerState();
  const hasTrack = Boolean(player.currentTrack);

  const itemClass = (active: boolean) =>
    `flex flex-1 min-w-0 h-[48px] flex-col items-center justify-center gap-[2px] rounded-lg border-0 bg-transparent cursor-pointer transition-colors active:scale-[0.97] ${
      active ? "text-text-primary" : "text-text-tertiary"
    }`;

  const iconClass = (active: boolean) =>
    active ? "opacity-100" : "opacity-65";

  const homeActive = pathname === "/" || pathname === "/home";
  const libraryActive = pathname === "/library" || pathname.startsWith("/library/");

  return (
    <nav
      aria-label={t("common.navigation") || "Navigation"}
      className="md:hidden shrink-0 w-full border-t border-border-primary/60 bg-bg-primary/95 backdrop-blur-xl"
      style={{
        paddingBottom:
          "max(env(safe-area-inset-bottom), var(--inset-bottom, 0px))",
      }}
    >
      <div className="flex items-stretch px-1.5 pt-1" style={{ minHeight: 52 }}>
        <Link to="/" aria-current={homeActive ? "page" : undefined} className={itemClass(homeActive)}>
          <Home7Fill size={21} className={iconClass(homeActive)} />
          <span className="text-[10px] leading-none font-medium">
            {t("common.sidebar.home") || "Home"}
          </span>
        </Link>

        <button
          type="button"
          aria-pressed={searchOpen}
          onClick={onSearchToggle}
          className={itemClass(searchOpen)}
        >
          <Search3Fill size={21} className={iconClass(searchOpen)} />
          <span className="text-[10px] leading-none font-medium">
            {t("common.sidebar.search") || "Search"}
          </span>
        </button>

        <Link
          to="/library"
          aria-current={libraryActive ? "page" : undefined}
          className={itemClass(libraryActive)}
        >
          <BookmarksFill size={21} className={iconClass(libraryActive)} />
          <span className="text-[10px] leading-none font-medium">
            {t("common.sidebar.library") || "Library"}
          </span>
        </Link>

        <button
          type="button"
          disabled={!hasTrack}
          aria-disabled={!hasTrack}
          aria-label={t("common.sidebar.now_playing") || "Now playing"}
          onClick={() => {
            if (hasTrack) setFullscreen(true);
          }}
          className={`${itemClass(player.fullscreen)} ${hasTrack ? "" : "opacity-35"}`}
        >
          <Music2Fill size={21} className={iconClass(player.fullscreen)} />
          <span className="text-[10px] leading-none font-medium">
            {t("common.sidebar.now_playing") || "Playing"}
          </span>
        </button>

        <button
          type="button"
          aria-pressed={settingsOpen}
          onClick={toggleSettings}
          className={itemClass(settingsOpen)}
        >
          <Settings4Fill size={21} className={iconClass(settingsOpen)} />
          <span className="text-[10px] leading-none font-medium">
            {t("common.sidebar.settings") || "Settings"}
          </span>
        </button>
      </div>
    </nav>
  );
}

export default memo(MobileNav);
