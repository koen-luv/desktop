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
import { useModalStore } from "@/features/library";
import { useCustomizationStore, getBlockStyle } from "@/features/settings/store/customizationStore";
import { Tooltip } from "@/shared/ui";


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

interface SidebarProps {
  searchOpen: boolean;
  onSearchToggle: () => void;
  isEdgeToEdge?: boolean;
}

function Sidebar({ searchOpen, onSearchToggle, isEdgeToEdge = false }: SidebarProps) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const accentVariant = usePlayerStore((state) => state.accentVariant);
  const playerFullscreen = usePlayerStore((state) => state.fullscreen);
  const hasCurrentTrack = usePlayerStore((state) => Boolean(state.currentTrack));
  const setPlayerFullscreen = usePlayerStore((state) => state.setFullscreen);
  const settingsOpen = useModalStore((state) => state.settingsOpen);
  const toggleSettings = useModalStore((state) => state.toggleSettings);

  const isRouteActive = (href: string) => {
    if (href === "/") {
      return pathname === "/" || pathname === "/home";
    }
    return pathname === href || pathname?.startsWith(`${href}/`);
  };
  const isItemActive = (id: string, href?: string) => {
    if (id === "search") {
      return searchOpen;
    }
    if (id === "settings") {
      return settingsOpen;
    }
    return href ? isRouteActive(href) : false;
  };

  // Shared rail chip: every destination is the same 40px target so the rail
  // reads as one column, with a tinted chip instead of an opacity change.
  const railItemClass =
    "group relative inline-flex h-[40px] w-[40px] items-center justify-center rounded-[14px] border-0 bg-transparent p-0 cursor-pointer transition-[background-color,transform,box-shadow] duration-200 ease-[var(--motion-ease)] active:scale-[0.92] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-soft";
  const railStateClass = (active: boolean) =>
    active
      ? "bg-accent-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent-primary)_22%,transparent)]"
      : "hover:bg-bg-hover hover:scale-[1.04]";

  const renderNavItems = () =>
    sidebarNavItems
      .filter((item) => item.id !== "settings")
      .map((item) => {
      const active = isItemActive(item.id, item.href);
      const Icon = item.Icon;
      const tooltipLabel = t(`common.sidebar.${item.id}`) || item.label;

      if (item.id === "search") {
        return (
          <Tooltip
            key={item.id}
            content={tooltipLabel}
            side="right"
            sideOffset={12}
          >
            <button
              type="button"
              aria-pressed={searchOpen}
              onClick={onSearchToggle}
              className={`${railItemClass} ${railStateClass(active)}`}
            >
              <Icon
                size={21}
                className={`relative z-10 transition-colors duration-150 ease-out ${
                  active ? "text-accent-primary" : "text-text-primary/60"
                }`}
              />
            </button>
          </Tooltip>
        );
      }

      return (
        <Tooltip
          key={item.id}
          content={tooltipLabel}
          side="right"
          sideOffset={12}
        >
          <Link
            key={item.id}
            to={item.href!}
            aria-current={active ? "page" : undefined}
            className={`${railItemClass} ${railStateClass(active)}`}
          >
            <Icon
              size={21}
              className={`relative z-10 transition-colors duration-150 ease-out ${
                active ? "text-accent-primary" : "text-text-primary/60"
              }`}
            />
            {active && (
              <span
                aria-hidden="true"
                className="absolute -left-[6px] top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-full bg-accent-primary shadow-[0_0_10px_var(--accent-primary)]"
              />
            )}
          </Link>
        </Tooltip>
      );
      });

  const renderSettingsButton = () => {
    const settingsItem = sidebarNavItems.find((item) => item.id === "settings");
    if (!settingsItem) return null;
    const Icon = settingsItem.Icon;
    const tooltipLabel = t("common.sidebar.settings") || settingsItem.label;
    return (
      <Tooltip
        content={tooltipLabel}
        side="right"
        sideOffset={12}
      >
        <button
          type="button"
          aria-pressed={settingsOpen}
          onClick={toggleSettings}
          className={`${railItemClass} ${railStateClass(settingsOpen)}`}
        >
          <Icon
            size={21}
            className={`relative z-10 transition-colors duration-150 ease-out ${
              settingsOpen ? "text-accent-primary" : "text-text-primary/60"
            }`}
          />
          {settingsOpen && (
            <span
              aria-hidden="true"
              className="absolute -left-[7px] top-1/2 h-[16px] w-[3px] -translate-y-1/2 rounded-full bg-accent-primary"
            />
          )}
        </button>
      </Tooltip>
    );
  };

  const { resolvedTheme } = useTheme();
  const isDark =
    resolvedTheme
      ? resolvedTheme === "dark"
      : typeof document !== "undefined" &&
        (document.documentElement.getAttribute("data-theme") === "dark" ||
          (!document.documentElement.getAttribute("data-theme") &&
            window.matchMedia?.("(prefers-color-scheme: dark)")?.matches));
  const backgroundImage = useCustomizationStore((state) => state.backgroundImage);
  const sidebarConfig = useCustomizationStore((state) => state.sidebar);
  const hasCustomBg = Boolean(backgroundImage);
  const sidebarStyle = getBlockStyle(sidebarConfig, isDark, hasCustomBg);

  return (
    <aside className="h-full">
      <div
        className={`h-full w-[58px] ${
          isEdgeToEdge ? "rounded-none" : "rounded-none md:rounded-[28px]"
        } ${
          hasCustomBg ? "" : "bg-bg-surface"
        } flex flex-col overflow-hidden ${
          isEdgeToEdge ? "" : "md:border md:border-border-primary/60 md:shadow-e1"
        }`}
        style={sidebarStyle}
      >
        <div className="flex justify-center items-center pt-[16px] pb-[10px] shrink-0">

          <AppImage
            src={
              accentVariant === "default"
                ? logo
                : brandingLogos[accentVariant]
            }
            alt="Logo"
            width={34}
            height={34}
            className={
              "w-[34px] h-[34px] " +
              (accentVariant === "default" ||
              accentVariant === "carbon" ||
              accentVariant === "pixel" ||
              accentVariant === "scanlines"
                ? "theme-logo invert dark:invert-0"
                : "")
            }
            draggable={false}
          />
        </div>

        <div className="mx-auto h-px w-[22px] shrink-0 bg-border-primary" aria-hidden="true" />

        <nav className="relative flex-1 flex flex-col items-center gap-[6px] pt-[10px]">
          {renderNavItems()}
          <Tooltip
            content={t("common.sidebar.player") || "Player"}
            side="right"
            sideOffset={12}
          >
            <button
              type="button"
              aria-label={t("common.sidebar.player") || "Player"}
              aria-pressed={playerFullscreen}
              disabled={!hasCurrentTrack}
              onClick={() => setPlayerFullscreen(true)}
              className={`${railItemClass} ${railStateClass(playerFullscreen)} disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent`}
            >
              <MusicNote
                size={21}
                className={`relative z-10 transition-colors duration-150 ease-out ${
                  playerFullscreen ? "text-accent-primary" : "text-text-primary/60"
                }`}
              />
              {playerFullscreen && (
                <span
                  aria-hidden="true"
                  className="absolute -left-[6px] top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-full bg-accent-primary shadow-[0_0_10px_var(--accent-primary)]"
                />
              )}
            </button>
          </Tooltip>
        </nav>

        <div className="w-full px-[10px] shrink-0" aria-hidden="true">
          <div className="h-px w-full bg-border-primary" />
        </div>

        <div className="pt-[10px] pb-[14px] shrink-0 flex justify-center items-center">
          {renderSettingsButton()}
        </div>
      </div>
    </aside>
  );
}

export default memo(Sidebar);
