import { memo } from "react";
import AppImage from "@/features/covers/ui/AppImage";
import { Link, useLocation } from "react-router-dom";
import { sidebarNavItems } from "../data/navigation";
import logo from "@/assets/logo.svg";
import spotifyLogo from "@/assets/branding/logo-spotify.svg";
import discordLogo from "@/assets/branding/logo-discord.svg";
import telegramLogo from "@/assets/branding/logo-telegram.svg";
import auroraLogo from "@/assets/branding/logo-aurora.svg";
import sunsetLogo from "@/assets/branding/logo-sunset.svg";
import oceanLogo from "@/assets/branding/logo-ocean.svg";
import forestLogo from "@/assets/branding/logo-forest.svg";
import berryLogo from "@/assets/branding/logo-berry.svg";
import carbonLogo from "@/assets/branding/logo-carbon.svg";
import pixelLogo from "@/assets/branding/logo-pixel.svg";
import scanlinesLogo from "@/assets/branding/logo-scanlines.svg";
import vhsLogo from "@/assets/branding/logo-vhs.svg";
import { useTranslation } from "@/languages";
import { useTheme } from "next-themes";
import { usePlayerStore, type AccentVariant } from "@/features/player";
import { MusicNote } from "@solar-icons/react";
import { Settings4Fill } from "@mingcute/react";
import { useModalStore } from "@/features/library";
import { useCustomizationStore, getBlockStyle } from "@/features/settings/store/customizationStore";
import { Tooltip } from "@/shared/ui";
import SleeveEdge from "./SleeveEdge";

const brandingLogos: Record<Exclude<AccentVariant, "default">, string> = {
  spotify: spotifyLogo,
  discord: discordLogo,
  telegram: telegramLogo,
  aurora: auroraLogo,
  sunset: sunsetLogo,
  ocean: oceanLogo,
  forest: forestLogo,
  berry: berryLogo,
  carbon: carbonLogo,
  pixel: pixelLogo,
  scanlines: scanlinesLogo,
  vhs: vhsLogo,
};

const invertedVariants: AccentVariant[] = ["default", "carbon", "pixel", "scanlines"];

interface SidebarProps {
  searchOpen: boolean;
  onSearchToggle: () => void;
  isEdgeToEdge?: boolean;
}

/**
 * Desktop navigation spine. A spine, not a toolbar: one column of 44px targets,
 * an accessible name on each (the tooltip is a nicety, never the only label),
 * and the sleeve edge marking the boundary against the content surface.
 */
function Sidebar({ searchOpen, onSearchToggle, isEdgeToEdge = false }: SidebarProps) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const accentVariant = usePlayerStore((state) => state.accentVariant);
  const playerFullscreen = usePlayerStore((state) => state.fullscreen);
  const hasCurrentTrack = usePlayerStore((state) => Boolean(state.currentTrack));
  const setPlayerFullscreen = usePlayerStore((state) => state.setFullscreen);
  const settingsOpen = useModalStore((state) => state.settingsOpen);
  const toggleSettings = useModalStore((state) => state.toggleSettings);

  const isRouteActive = (href: string) =>
    href === "/" ? pathname === "/" || pathname === "/home" : pathname === href || pathname?.startsWith(`${href}/`);

  const isItemActive = (id: string, href?: string) => {
    if (id === "search") return searchOpen;
    if (id === "settings") return settingsOpen;
    return href ? isRouteActive(href) : false;
  };

  const itemClass =
    "group relative inline-flex h-[44px] w-[44px] items-center justify-center rounded-[12px] border-0 bg-transparent p-0 cursor-pointer transition-[background-color,color,transform] duration-150 ease-[var(--motion-ease)] active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface";
  const stateClass = (active: boolean) =>
    active ? "bg-bg-selected text-accent-primary" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary";

  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme
    ? resolvedTheme === "dark"
    : typeof document !== "undefined" &&
      (document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") &&
          window.matchMedia?.("(prefers-color-scheme: dark)")?.matches));
  const backgroundImage = useCustomizationStore((s) => s.backgroundImage);
  const sidebarConfig = useCustomizationStore((s) => s.sidebar);
  const hasCustomBg = Boolean(backgroundImage);
  const sidebarStyle = getBlockStyle(sidebarConfig, isDark, hasCustomBg);

  const label = (key: string, fallback: string) => t(`common.sidebar.${key}`) || fallback;
  const SettingsIcon = sidebarNavItems.find((item) => item.id === "settings")?.Icon ?? Settings4Fill;

  return (
    <aside className="h-full" aria-label={t("common.navigation") || "Navigation"}>
      <div
        className={`relative flex h-full w-[60px] flex-col overflow-hidden ${
          isEdgeToEdge ? "rounded-none" : "rounded-[24px] border border-border-primary/60"
        } ${hasCustomBg ? "" : "bg-bg-surface"} ${isEdgeToEdge ? "" : "shadow-e1"}`}
        style={sidebarStyle}
      >
        <div className="flex shrink-0 items-center justify-center pb-[6px] pt-[12px]">
          <AppImage
            src={accentVariant === "default" ? logo : brandingLogos[accentVariant]}
            alt="Neritium"
            width={30}
            height={30}
            className={
              "h-[30px] w-[30px] " + (invertedVariants.includes(accentVariant) ? "theme-logo invert dark:invert-0" : "")
            }
            draggable={false}
          />
        </div>

        <nav className="flex flex-1 flex-col items-center gap-[4px] pt-[8px]">
          {sidebarNavItems
            .filter((item) => item.id !== "settings")
            .map((item) => {
              const active = isItemActive(item.id, item.href);
              const Icon = item.Icon;
              const name = label(item.id, item.label);

              if (item.id === "search") {
                return (
                  <Tooltip key={item.id} content={name} side="right" sideOffset={10}>
                    <button
                      type="button"
                      aria-label={name}
                      aria-pressed={searchOpen}
                      onClick={onSearchToggle}
                      className={`${itemClass} ${stateClass(active)}`}
                    >
                      <Icon size={20} />
                    </button>
                  </Tooltip>
                );
              }

              return (
                <Tooltip key={item.id} content={name} side="right" sideOffset={10}>
                  <Link to={item.href!} aria-label={name} aria-current={active ? "page" : undefined} className={`${itemClass} ${stateClass(active)}`}>
                    <Icon size={20} />
                  </Link>
                </Tooltip>
              );
            })}

          <Tooltip content={label("player", "Player")} side="right" sideOffset={10}>
            <button
              type="button"
              aria-label={label("player", "Player")}
              aria-pressed={playerFullscreen}
              disabled={!hasCurrentTrack}
              onClick={() => setPlayerFullscreen(true)}
              className={`${itemClass} ${stateClass(playerFullscreen)} disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent`}
            >
              <MusicNote size={20} />
            </button>
          </Tooltip>
        </nav>

        <div className="flex shrink-0 items-center justify-center pb-[12px] pt-[8px]">
          <Tooltip content={label("settings", "Settings")} side="right" sideOffset={10}>
            <button
              type="button"
              aria-label={label("settings", "Settings")}
              aria-pressed={settingsOpen}
              onClick={toggleSettings}
              className={`${itemClass} ${stateClass(settingsOpen)}`}
            >
              <SettingsIcon size={20} />
            </button>
          </Tooltip>
        </div>

        <SleeveEdge className="absolute inset-y-0 right-0 rounded-r-[24px]" />
      </div>
    </aside>
  );
}

export default memo(Sidebar);
