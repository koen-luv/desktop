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
    `group flex flex-1 min-w-0 h-[50px] flex-col items-center justify-center gap-[3px] rounded-2xl border-0 bg-transparent cursor-pointer transition-[color,transform] duration-200 ease-[var(--motion-ease)] active:scale-[0.95] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-soft ${
      active ? "text-accent-primary" : "text-text-tertiary hover:text-text-secondary"
    }`;

  // A single pill shape carries the active state for every destination, so
  // touch users get the same "you are here" cue the desktop rail shows.
  const iconWrapClass = (active: boolean) =>
    `flex h-[28px] w-[48px] items-center justify-center rounded-full transition-[background-color,box-shadow] duration-200 ease-[var(--motion-ease)] ${
      active
        ? "bg-accent-soft text-accent-primary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent-primary)_20%,transparent)]"
        : "bg-transparent"
    }`;

  const labelClass = (active: boolean) =>
    `text-[10px] leading-none tracking-[0.01em] ${
      active ? "font-[600]" : "font-[500]"
    }`;

  const homeActive = pathname === "/" || pathname === "/home";
  const libraryActive = pathname === "/library" || pathname.startsWith("/library/");

  return (
    <nav
      aria-label={t("common.navigation") || "Navigation"}
      className="md:hidden shrink-0 w-[calc(100%-16px)] mx-2 mb-2 rounded-[22px] border border-border-primary/70 bg-bg-surface/88 shadow-e2 backdrop-blur-2xl"
      style={{
        paddingBottom:
          "max(env(safe-area-inset-bottom), var(--inset-bottom, 0px))",
      }}
    >
      <div className="flex items-stretch px-1.5 pt-1" style={{ minHeight: 58 }}>
        <Link to="/" aria-current={homeActive ? "page" : undefined} className={itemClass(homeActive)}>
          <span className={iconWrapClass(homeActive)}>
            <Home7Fill size={20} />
          </span>
          <span className={labelClass(homeActive)}>
            {t("common.sidebar.home") || "Home"}
          </span>
        </Link>

        <button
          type="button"
          aria-pressed={searchOpen}
          onClick={onSearchToggle}
          className={itemClass(searchOpen)}
        >
          <span className={iconWrapClass(searchOpen)}>
            <Search3Fill size={20} />
          </span>
          <span className={labelClass(searchOpen)}>
            {t("common.sidebar.search") || "Search"}
          </span>
        </button>

        <Link
          to="/library"
          aria-current={libraryActive ? "page" : undefined}
          className={itemClass(libraryActive)}
        >
          <span className={iconWrapClass(libraryActive)}>
            <BookmarksFill size={20} />
          </span>
          <span className={labelClass(libraryActive)}>
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
          <span className={iconWrapClass(player.fullscreen)}>
            <Music2Fill size={20} />
          </span>
          <span className={labelClass(player.fullscreen)}>
            {t("common.sidebar.now_playing") || "Playing"}
          </span>
        </button>

        <button
          type="button"
          aria-pressed={settingsOpen}
          onClick={toggleSettings}
          className={itemClass(settingsOpen)}
        >
          <span className={iconWrapClass(settingsOpen)}>
            <Settings4Fill size={20} />
          </span>
          <span className={labelClass(settingsOpen)}>
            {t("common.sidebar.settings") || "Settings"}
          </span>
        </button>
      </div>
    </nav>
  );
}

export default memo(MobileNav);
