import { memo } from "react";
import { Link, useLocation } from "react-router-dom";
import { Home7Fill, Search3Fill, BookmarksFill, Settings4Fill, Music2Fill } from "@mingcute/react";
import { useTranslation } from "@/languages";
import { useModalStore } from "@/features/library";
import { usePlayerStore } from "@/features/player";
import { usePlayerState } from "@/features/player/hooks/usePlayerState";
import { useCoverSrc } from "@/features/covers";
import SleeveEdge from "./SleeveEdge";

interface MobileDockProps {
  searchOpen: boolean;
  onSearchToggle: () => void;
}

/**
 * Phone navigation.
 *
 * Four destinations and the now-playing sleeve in the middle. The centre button
 * is the one thing a thumb reaches without moving the hand, so the current cover
 * lives there: it is the app's identity, the player's state, and the way into
 * the full player — one target instead of three.
 *
 * Nothing here depends on hover, every target is at least 48px, and the labels
 * sit under the icons so the dock is readable at a glance without a tooltip.
 */
function MobileDock({ searchOpen, onSearchToggle }: MobileDockProps) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const settingsOpen = useModalStore((state) => state.settingsOpen);
  const toggleSettings = useModalStore((state) => state.toggleSettings);
  const setFullscreen = usePlayerStore((state) => state.setFullscreen);
  const player = usePlayerState();
  const coverSrc = useCoverSrc(player.currentTrack?.coverUrl ?? undefined);
  const hasTrack = Boolean(player.currentTrack);
  const isPlaying = player.status === "playing" || player.status === "loading";

  const name = (key: string, fallback: string) => t(`common.sidebar.${key}`) || fallback;

  const tabClass = (active: boolean) =>
    `relative flex min-h-[48px] min-w-0 flex-1 flex-col items-center justify-center gap-[3px] rounded-[14px] border-0 bg-transparent px-1 cursor-pointer transition-colors duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/70 ${
      active ? "text-accent-primary" : "text-text-secondary"
    }`;

  const activePill = (active: boolean) =>
    active
      ? "absolute inset-x-1 top-1 bottom-1 rounded-[12px] bg-bg-selected"
      : "hidden";

  const homeActive = pathname === "/" || pathname === "/home";
  const libraryActive = pathname === "/library" || pathname.startsWith("/library/");

  return (
    <nav
      aria-label={t("common.navigation") || "Navigation"}
      className="relative mt-2 shrink-0 rounded-[22px] border border-border-primary/60 bg-bg-surface/98 md:hidden"
      style={{
        paddingBottom: "max(env(safe-area-inset-bottom), var(--inset-bottom, 0px))",
      }}
    >
      {/* The edge is clipped to the dock's corners; the nav itself must not clip,
          or the raised now-playing button would be cut off. */}
      <div className="overflow-hidden rounded-t-[22px]">
        <SleeveEdge orientation="horizontal" />
      </div>

      <div className="flex items-end gap-[2px] px-[6px] pb-[6px] pt-[6px]">
        <Link
          to="/"
          aria-label={name("home", "Home")}
          aria-current={homeActive ? "page" : undefined}
          className={tabClass(homeActive)}
        >
          <span className={activePill(homeActive)} aria-hidden="true" />
          <Home7Fill size={22} className="relative z-[1]" />
          <span className="relative z-[1] text-[10px] font-[500] leading-none">
            {name("home", "Home")}
          </span>
        </Link>

        <button
          type="button"
          aria-label={name("search", "Search")}
          aria-pressed={searchOpen}
          onClick={onSearchToggle}
          className={tabClass(searchOpen)}
        >
          <span className={activePill(searchOpen)} aria-hidden="true" />
          <Search3Fill size={22} className="relative z-[1]" />
          <span className="relative z-[1] text-[10px] font-[500] leading-none">
            {name("search", "Search")}
          </span>
        </button>

        {/* Now playing: the sleeve itself, raised out of the dock. */}
        <button
          type="button"
          disabled={!hasTrack}
          aria-label={name("now_playing", "Now playing")}
          aria-pressed={player.fullscreen}
          onClick={() => {
            if (hasTrack) setFullscreen(true);
          }}
          className={`group relative mx-[2px] flex h-[56px] w-[56px] shrink-0 items-center justify-center overflow-hidden rounded-[16px] border border-border-primary/60 bg-bg-panel shadow-e2 transition-transform duration-150 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/70 ${
            hasTrack ? "" : "opacity-60"
          }`}
        >
          {coverSrc ? (
            <img
              src={coverSrc}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <Music2Fill size={24} className="relative z-[1] text-text-secondary" />
          )}
          {hasTrack && (
            <span
              aria-hidden="true"
              className={`absolute inset-0 bg-black/25 transition-opacity duration-200 ${
                isPlaying ? "opacity-100" : "opacity-60"
              }`}
            />
          )}
          {hasTrack && (
            <Music2Fill
              size={22}
              className={`relative z-[1] drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] ${
                isPlaying ? "text-white" : "text-white/70"
              }`}
            />
          )}
        </button>

        <Link
          to="/library"
          aria-label={name("library", "Library")}
          aria-current={libraryActive ? "page" : undefined}
          className={tabClass(libraryActive)}
        >
          <span className={activePill(libraryActive)} aria-hidden="true" />
          <BookmarksFill size={22} className="relative z-[1]" />
          <span className="relative z-[1] text-[10px] font-[500] leading-none">
            {name("library", "Library")}
          </span>
        </Link>

        <button
          type="button"
          aria-label={name("settings", "Settings")}
          aria-pressed={settingsOpen}
          onClick={toggleSettings}
          className={tabClass(settingsOpen)}
        >
          <span className={activePill(settingsOpen)} aria-hidden="true" />
          <Settings4Fill size={22} className="relative z-[1]" />
          <span className="relative z-[1] text-[10px] font-[500] leading-none">
            {name("settings", "Settings")}
          </span>
        </button>
      </div>
    </nav>
  );
}

export default memo(MobileDock);
