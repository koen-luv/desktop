import { useMemo, useState, useEffect, useRef, type ComponentType } from "react";
import { motion } from "framer-motion";
import {
  CloseLine,
  Search2Line,
  CloseCircleFill,
  ExitLine,
  ArrowLeftLine,
  RightLine,
} from "@mingcute/react";
import {
  Play,
  Palette,
  Gallery,
  HeadphonesRound,
  InfoCircle,
  Database,
  Widget5,
  Book2,
  QuestionCircle,
} from "@solar-icons/react";
import Dialog from "@/shared/ui/Dialog";
import { UserAvatar } from "@/shared/ui";
import { useTranslation, getTranslationsForAllLocales } from "@/languages";
import { useModalStore } from "@/features/library/store/modalStore";
import { useAuthStore } from "@/features/auth";
import { isAndroidApp } from "@/platform";
import {
  PlaybackTab,
  AppearanceTab,
  CustomizationTab,
  AudioTab,
  StorageTab,
  AboutTab,
  OverlayTab,
} from "./tabs";

/**
 * Settings is a two-level menu.
 *
 * Level 1 lists a handful of grouped categories instead of every tab, so the
 * dialog never shows a wall of navigation. Level 2 opens one category in its
 * own screen (with a back button) and stacks that category's sections under
 * their own headings. Desktop and Android share this exact structure.
 */
type SectionId = "Playback" | "Overlay" | "Appearance" | "Customization" | "Audio" | "Storage" | "About";
type CategoryId = "playback" | "appearance" | "overlay" | "storage" | "about";
type GroupId = "preferences" | "application";

const SECTION_ICONS: Record<SectionId, typeof Play> = {
  Playback: Play,
  Overlay: Widget5,
  Appearance: Palette,
  Customization: Gallery,
  Audio: HeadphonesRound,
  Storage: Database,
  About: InfoCircle,
};

const SECTION_COMPONENTS: Record<SectionId, ComponentType<{ searchQuery?: string }>> = {
  Playback: PlaybackTab,
  Overlay: OverlayTab,
  Appearance: AppearanceTab,
  Customization: CustomizationTab,
  Audio: AudioTab,
  Storage: StorageTab,
  About: AboutTab,
};

const CATEGORIES: { id: CategoryId; group: GroupId; sections: SectionId[] }[] = [
  { id: "playback", group: "preferences", sections: ["Playback", "Audio"] },
  { id: "appearance", group: "preferences", sections: ["Appearance", "Customization"] },
  { id: "overlay", group: "preferences", sections: ["Overlay"] },
  { id: "storage", group: "application", sections: ["Storage"] },
  { id: "about", group: "application", sections: ["About"] },
];

const GROUP_IDS: GroupId[] = ["preferences", "application"];


const SETTING_ITEMS: { sectionId: SectionId; titleKey: string; descKey?: string; overlayOnly?: boolean }[] = [
  // Playback
  { sectionId: "Playback", titleKey: "settings.autoplay_similar.title", descKey: "settings.autoplay_similar.description" },
  { sectionId: "Playback", titleKey: "settings.transitions.title", descKey: "settings.transitions.description" },
  { sectionId: "Playback", titleKey: "settings.sleep_timer.title", descKey: "settings.sleep_timer.description" },
  { sectionId: "Overlay", titleKey: "settings.discord.enabled.title", descKey: "settings.discord.enabled.description" },
  { sectionId: "Overlay", titleKey: "settings.discord.client_id.title", descKey: "settings.discord.client_id.description" },
  { sectionId: "Playback", titleKey: "settings.track_double_click.title", descKey: "settings.track_double_click.description" },
  { sectionId: "Playback", titleKey: "settings.default_playback_context.title", descKey: "settings.default_playback_context.description" },
  { sectionId: "Playback", titleKey: "settings.audio.pause_on_device_change.title", descKey: "settings.audio.pause_on_device_change.description" },

  // Overlay
  { sectionId: "Overlay", titleKey: "settings.overlay.position.title", descKey: "settings.overlay.position.description", overlayOnly: true },
  { sectionId: "Overlay", titleKey: "settings.overlay.show_lyrics.title", descKey: "settings.overlay.show_lyrics.description", overlayOnly: true },
  { sectionId: "Overlay", titleKey: "settings.overlay.auto_show_on_minimize.title", descKey: "settings.overlay.auto_show_on_minimize.description", overlayOnly: true },
  { sectionId: "Overlay", titleKey: "settings.overlay.always_on_top.title", descKey: "settings.overlay.always_on_top.description", overlayOnly: true },

  // Appearance
  { sectionId: "Appearance", titleKey: "settings.language.label", descKey: "settings.language.description" },
  { sectionId: "Appearance", titleKey: "settings.theme.title", descKey: "settings.theme.description" },
  { sectionId: "Appearance", titleKey: "settings.branding.title", descKey: "settings.branding.description" },

  // Customization
  { sectionId: "Customization", titleKey: "settings.customization.wallpaper_title", descKey: "settings.customization.wallpaper_description" },
  { sectionId: "Customization", titleKey: "settings.customization.blocks_title", descKey: "settings.customization.blocks_description" },
  { sectionId: "Customization", titleKey: "settings.customization.reset_all", descKey: "settings.customization.reset_all_desc" },

  // Audio
  { sectionId: "Audio", titleKey: "settings.audio.title", descKey: "settings.audio.description" },
  { sectionId: "Audio", titleKey: "settings.connection.checks_title" },

  // Storage
  { sectionId: "Storage", titleKey: "settings.storage.title", descKey: "settings.storage.description" },
  { sectionId: "Storage", titleKey: "settings.storage.usage_title" },
  { sectionId: "Storage", titleKey: "settings.storage.open_folder", descKey: "settings.storage.open_folder_description" },

  // About
  { sectionId: "About", titleKey: "settings.about.liner", descKey: "common.app.version" },
  { sectionId: "About", titleKey: "settings.notifications.test_button" },
];

const SECTION_LABEL_KEYS: Record<SectionId, string> = {
  Playback: "settings.tabs.playback",
  Overlay: "settings.tabs.overlay",
  Appearance: "settings.theme.title",
  Customization: "settings.tabs.customization",
  Audio: "settings.tabs.audio",
  Storage: "settings.tabs.storage",
  About: "settings.tabs.about",
};

const SECTION_DESC_KEYS: Record<SectionId, string> = {
  Playback: "settings.playback.description",
  Overlay: "settings.overlay.description",
  Appearance: "settings.theme.description",
  Customization: "settings.customization.description",
  Audio: "settings.audio.description",
  Storage: "settings.storage.description",
  About: "settings.about.tagline",
};

const font = { fontFamily: "var(--font-inter), sans-serif" } as const;

export default function SettingsModal() {
  const { t } = useTranslation();
  const open = useModalStore((state) => state.settingsOpen);
  const close = useModalStore((state) => state.closeSettings);

  const [openCategoryId, setOpenCategoryId] = useState<CategoryId | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [navDirection, setNavDirection] = useState<1 | -1>(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingSectionRef = useRef<SectionId | null>(null);

  const handleClose = () => {
    setSearchQuery("");
    setOpenCategoryId(null);
    close();
  };

  const openCategory = (id: CategoryId, focusSection?: SectionId) => {
    pendingSectionRef.current = focusSection ?? null;
    setNavDirection(1);
    setOpenCategoryId(id);
  };

  const backToMenu = () => {
    setNavDirection(-1);
    setOpenCategoryId(null);
  };

  const categoryTitles: Record<CategoryId, string> = {
    playback: t("settings.categories.playback.title"),
    appearance: t("settings.categories.appearance.title"),
    overlay: t("settings.categories.overlay.title"),
    storage: t("settings.categories.storage.title"),
    about: t("settings.categories.about.title"),
  };

  const categoryDescriptions: Record<CategoryId, string> = {
    playback: t("settings.categories.playback.description"),
    appearance: t("settings.categories.appearance.description"),
    overlay: t("settings.categories.overlay.description"),
    storage: t("settings.categories.storage.description"),
    about: t("settings.categories.about.description"),
  };

  const sectionTitles: Record<SectionId, string> = {
    Playback: t("settings.tabs.playback"),
    // On Android this section is the Discord block; its heading only shows up
    // in search results, since a single-section category renders without one.
    Overlay: isAndroidApp()
      ? t("settings.discord.section") || "Discord"
      : t("settings.tabs.overlay") || "Overlay",
    Appearance: t("settings.tabs.appearance"),
    Customization: t("settings.tabs.customization") || "Customization",
    Audio: t("settings.tabs.audio"),
    Storage: t("settings.tabs.storage"),
    About: t("settings.tabs.about"),
  };

  const sectionDescriptions: Record<SectionId, string> = {
    Playback: t("settings.playback.description"),
    Overlay: isAndroidApp()
      ? ""
      : t("settings.overlay.description") || "Desktop overlay behavior, position and lyrics display.",
    Appearance: t("settings.theme.description"),
    Customization: t("settings.customization.description") || "Window background wallpaper, transparency and block blur effects.",
    Audio: t("settings.audio.description"),
    Storage: t("settings.storage.description"),
    About: t("settings.about.tagline"),
  };

  const isSearching = searchQuery.trim().length > 0;

  // Sections whose own label/description matches, and sections that contain a
  // matching setting row. The latter decides which rows get filtered down, so
  // a label-only hit still opens a fully populated section.
  const matches = useMemo(() => {
    if (!searchQuery.trim()) return { labelMatches: null, rowMatches: null };
    const query = searchQuery.toLowerCase().trim();
    const labelMatches = new Set<SectionId>();
    const rowMatches = new Set<SectionId>();
    // On Android the Overlay section only carries the Discord rows, so the
    // overlay-only label and rows must not surface in search there.
    const android = isAndroidApp();

    (Object.keys(SECTION_LABEL_KEYS) as SectionId[]).forEach((sectionId) => {
      if (android && sectionId === "Overlay") return;
      const texts = [
        ...getTranslationsForAllLocales(SECTION_LABEL_KEYS[sectionId]),
        ...getTranslationsForAllLocales(SECTION_DESC_KEYS[sectionId]),
      ];
      if (texts.some((txt) => txt.toLowerCase().includes(query))) labelMatches.add(sectionId);
    });

    SETTING_ITEMS.forEach((item) => {
      if (android && item.overlayOnly) return;
      const texts = [
        ...getTranslationsForAllLocales(item.titleKey),
        ...(item.descKey ? getTranslationsForAllLocales(item.descKey) : []),
      ];
      if (texts.some((txt) => txt.toLowerCase().includes(query))) rowMatches.add(item.sectionId);
    });

    return { labelMatches, rowMatches };
  }, [searchQuery]);

  const matchingSections = useMemo(() => {
    const set = new Set<SectionId>();
    if (matches.labelMatches) for (const id of matches.labelMatches) set.add(id);
    if (matches.rowMatches) for (const id of matches.rowMatches) set.add(id);
    return set;
  }, [matches]);

  // The overlay is a separate always-on-top desktop window and has no Android
  // equivalent, so that category is kept only where something inside it
  // actually works: the floating window on desktop, and Discord Rich Presence
  // (shipped through the Android platform shim) on Android.
  const availableCategories = useMemo(
    () =>
      CATEGORIES.filter((cat) => {
        if (cat.id !== "overlay" || !isAndroidApp()) return true;
        return Boolean(window.linerElectron?.discordRpcConfigure);
      }),
    [],
  );

  const visibleCategories = useMemo(() => {
    if (!isSearching) return availableCategories;
    return availableCategories.filter((cat) => cat.sections.some((id) => matchingSections.has(id)));
  }, [availableCategories, isSearching, matchingSections]);

  // Flat section hits for the search results list (level 1 search results).
  const searchResults = useMemo(() => {
    if (!isSearching) return null;
    return visibleCategories.flatMap((cat) =>
      cat.sections
        .filter((id) => matchingSections.has(id))
        .map((sectionId) => ({ categoryId: cat.id, sectionId })),
    );
  }, [isSearching, visibleCategories, matchingSections]);

  const activeCategory = useMemo(
    () => visibleCategories.find((cat) => cat.id === openCategoryId) ?? null,
    [visibleCategories, openCategoryId],
  );

  // When search opened a category, jump to the section that matched; a plain
  // menu tap just starts the screen at the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pending = pendingSectionRef.current;
    pendingSectionRef.current = null;
    if (pending) {
      const target = el.querySelector<HTMLElement>(`[data-section="${pending}"]`);
      if (target) {
        requestAnimationFrame(() => target.scrollIntoView?.({ block: "start" }));
        return;
      }
    }
    el.scrollTop = 0;
  }, [openCategoryId]);

  const openExternal = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const displayName =
    user?.displayName ||
    user?.username ||
    user?.email?.split("@")[0] ||
    "Liner";
  const handle = user?.username ? `@${user.username}` : (user?.email ?? t("settings.manage_account"));

  const closeIcon = (
    <button
      type="button"
      aria-label={t("common.close") || "Close"}
      onClick={handleClose}
      className="w-[28px] h-[28px] shrink-0 inline-flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-border-alpha-14 transition-colors border-0 bg-transparent p-0 cursor-pointer"
    >
      <CloseLine size={17} />
    </button>
  );

  const renderCategoryRow = (cat: { id: CategoryId; sections: SectionId[] }) => {
    const Icon = SECTION_ICONS[cat.sections[0]];
    return (
      <button
        key={cat.id}
        type="button"
        onClick={() => {
          setSearchQuery("");
          openCategory(cat.id);
        }}
        className="w-full flex items-center gap-[12px] px-[12px] py-[11px] rounded-[10px] border-0 bg-transparent hover:bg-border-alpha-14 cursor-pointer text-left transition-colors"
        style={font}
      >
        <Icon size={20} weight="Bold" className="text-text-tertiary shrink-0" />
        <span className="flex-1 min-w-0 flex flex-col gap-[2px]">
          <span className="text-text-primary text-[13.5px] font-[500] leading-snug">
            {categoryTitles[cat.id]}
          </span>
          <span className="text-text-tertiary text-[12.5px] leading-snug">
            {categoryDescriptions[cat.id]}
          </span>
        </span>
        <RightLine size={15} className="text-text-tertiary shrink-0" />
      </button>
    );
  };

  const renderSearchResult = ({
    categoryId,
    sectionId,
  }: {
    categoryId: CategoryId;
    sectionId: SectionId;
  }) => {
    const Icon = SECTION_ICONS[sectionId];
    return (
      <button
        key={`${categoryId}:${sectionId}`}
        type="button"
        onClick={() => openCategory(categoryId, sectionId)}
        className="w-full flex items-center gap-[12px] px-[12px] py-[11px] rounded-[10px] border-0 bg-transparent hover:bg-border-alpha-14 cursor-pointer text-left transition-colors"
        style={font}
      >
        <Icon size={20} weight="Bold" className="text-text-tertiary shrink-0" />
        <span className="flex-1 min-w-0 flex flex-col gap-[2px]">
          <span className="text-text-tertiary text-[11px] font-[500] uppercase tracking-[0.06em] leading-none">
            {categoryTitles[categoryId]}
          </span>
          <span className="text-text-primary text-[13.5px] font-[500] leading-snug">
            {sectionTitles[sectionId]}
          </span>
          <span className="text-text-tertiary text-[12.5px] leading-snug">
            {sectionDescriptions[sectionId]}
          </span>
        </span>
        <RightLine size={15} className="text-text-tertiary shrink-0" />
      </button>
    );
  };

  const menuScreen = (
    <>
      {searchResults ? (
        searchResults.length === 0 ? (
          <p className="text-text-tertiary text-[12.5px] px-[6px] py-[10px] m-0" style={font}>
            {t("search.no_results") || "Nothing found"}
          </p>
        ) : (
          <div role="list" className="flex flex-col gap-[4px]">
            {searchResults.map(renderSearchResult)}
          </div>
        )
      ) : (
        <>
          <nav
            className="flex flex-col gap-[16px]"
            aria-label={t("settings.title")}
          >
            {GROUP_IDS.map((groupId) => {
              const inGroup = visibleCategories.filter((cat) => cat.group === groupId);
              if (inGroup.length === 0) return null;
              return (
                <div key={groupId} className="flex flex-col gap-[4px]">
                  <p
                    className="text-text-tertiary text-[11px] font-[500] m-0 px-[6px] pb-[4px]"
                    style={font}
                  >
                    {t(`settings.groups.${groupId}`)}
                  </p>
                  {inGroup.map(renderCategoryRow)}
                </div>
              );
            })}
          </nav>

          <div className="flex flex-col gap-[4px] pt-[14px] mt-[6px] border-t border-solid border-border-primary">
            <p
              className="text-text-tertiary text-[11px] font-[500] m-0 px-[6px] pb-[4px]"
              style={font}
            >
              {t("settings.groups.help")}
            </p>
            <button
              type="button"
              onClick={() => openExternal("https://github.com/tryliner/desktop/blob/main/README.md")}
              className="w-full flex items-center gap-[12px] px-[12px] py-[10px] rounded-[10px] border-0 bg-transparent text-text-secondary hover:bg-border-alpha-14 hover:text-text-primary cursor-pointer text-left transition-colors"
              style={{ ...font, fontSize: "13.5px" }}
            >
              <Book2 size={17} weight="Bold" className="text-text-tertiary shrink-0" />
              <span className="leading-none">{t("settings.docs")}</span>
              <RightLine size={15} className="ml-auto text-text-tertiary shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => openExternal("https://t.me/liner_app?direct")}
              className="w-full flex items-center gap-[12px] px-[12px] py-[10px] rounded-[10px] border-0 bg-transparent text-text-secondary hover:bg-border-alpha-14 hover:text-text-primary cursor-pointer text-left transition-colors"
              style={{ ...font, fontSize: "13.5px" }}
            >
              <QuestionCircle size={17} weight="Bold" className="text-text-tertiary shrink-0" />
              <span className="leading-none">{t("settings.support")}</span>
              <RightLine size={15} className="ml-auto text-text-tertiary shrink-0" />
            </button>
          </div>
        </>
      )}
    </>
  );

  const categoryScreen = activeCategory ? (
    <div className="flex flex-col">
      {activeCategory.sections
        .filter((sectionId) => !matchingSections.size || matchingSections.has(sectionId))
        .map((sectionId, index) => {
          const SectionComponent = SECTION_COMPONENTS[sectionId];
          const Icon = SECTION_ICONS[sectionId];
          const withHeading = activeCategory.sections.length > 1;
          const rowsFiltered = Boolean(matches.rowMatches?.has(sectionId));
          return (
            <div
              key={sectionId}
              data-section={sectionId}
              className={
                index > 0 ? "mt-[18px] pt-[16px] border-t border-solid border-border-primary" : ""
              }
            >
              {withHeading ? (
                <div className="flex items-start gap-[10px] pb-[2px]">
                  <Icon size={18} weight="Bold" className="text-text-tertiary shrink-0 mt-[1px]" />
                  <div className="min-w-0">
                    <p
                      className="text-text-primary text-[13px] font-[600] m-0 leading-snug"
                      style={font}
                    >
                      {sectionTitles[sectionId]}
                    </p>
                    <p
                      className="text-text-tertiary text-[12.5px] m-0 mt-[2px] leading-snug"
                      style={font}
                    >
                      {sectionDescriptions[sectionId]}
                    </p>
                  </div>
                </div>
              ) : null}
              <SectionComponent searchQuery={rowsFiltered ? searchQuery : undefined} />
            </div>
          );
        })}
    </div>
  ) : null;

  const screenKey = openCategoryId ? `category:${openCategoryId}` : `menu:${isSearching ? "search" : "root"}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (!next ? handleClose() : undefined)}
      maxWidth={720}
      className="p-0 h-[70dvh] max-h-[70dvh] md:h-[640px] md:max-h-[86vh] !flex-col overflow-hidden !bg-bg-elevated !border-0"
    >
      <div className="flex-1 min-h-0 flex flex-col">
        {/* ── Header: search on the menu, back + title inside a category ── */}
        <div className="shrink-0 px-4 md:px-6 pt-4 pb-[10px]">
          {openCategoryId && activeCategory ? (
            <div className="flex items-start gap-[10px]">
              <button
                type="button"
                aria-label={t("common.back") || "Back"}
                onClick={backToMenu}
                className="w-[28px] h-[28px] mt-[1px] shrink-0 inline-flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-border-alpha-14 transition-colors border-0 bg-transparent p-0 cursor-pointer"
              >
                <ArrowLeftLine size={18} />
              </button>
              <div className="flex-1 min-w-0">
                <h3
                  className="text-text-primary text-[15px] m-0 font-[600] tracking-[-0.01em]"
                  style={font}
                >
                  {categoryTitles[activeCategory.id]}
                </h3>
                <p
                  className="text-text-tertiary text-[13px] m-0 mt-[3px] leading-snug"
                  style={font}
                >
                  {categoryDescriptions[activeCategory.id]}
                </p>
              </div>
              {closeIcon}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-[16px]">
                <h3
                  className="text-text-primary text-[15px] m-0 font-[600] tracking-[-0.01em]"
                  style={font}
                >
                  {t("settings.title")}
                </h3>
                {closeIcon}
              </div>
              <div className="relative flex items-center mt-[12px]">
                <Search2Line
                  size={15}
                  className="absolute left-[10px] text-text-tertiary pointer-events-none"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("settings.search_placeholder")}
                  className="w-full h-[32px] pl-[30px] pr-[26px] bg-border-alpha-14 text-text-primary text-[13px] rounded-[8px] border-0 outline-none placeholder:text-text-tertiary focus:bg-border-alpha-20 transition-colors"
                  style={font}
                />
                {searchQuery && (
                  <button
                    type="button"
                    aria-label={t("common.cancel") || "Clear"}
                    onClick={() => setSearchQuery("")}
                    className="absolute right-[6px] p-0 border-0 bg-transparent text-text-tertiary hover:text-text-primary cursor-pointer flex items-center justify-center"
                  >
                    <CloseCircleFill size={14} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Body: one menu at a time ── */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pb-[8px]">
          <motion.div
            key={screenKey}
            initial={{ opacity: 0, x: navDirection * 14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="mx-auto w-full max-w-[600px]"
          >
            {openCategoryId ? categoryScreen : menuScreen}
          </motion.div>
        </div>

        {/* ── Footer: profile stays on the menu only ── */}
        {!openCategoryId && (
          <div className="shrink-0 px-4 md:px-6 py-[10px] border-t border-solid border-border-primary">
            <div className="mx-auto w-full max-w-[600px] flex items-center gap-[10px] px-[6px] min-w-0">
              <span className="relative shrink-0">
                <UserAvatar user={user ?? null} size={32} />
                <span
                  className="absolute right-[-1px] bottom-[-1px] w-[10px] h-[10px] rounded-full bg-[#12B76A] border-2 border-bg-primary"
                  aria-hidden
                />
              </span>
              <span className="flex-1 min-w-0 flex flex-col leading-tight">
                <span className="text-text-primary text-[13px] font-[500] truncate" style={font}>
                  {displayName}
                </span>
                <span className="text-text-tertiary text-[12px] truncate" style={font}>
                  {handle}
                </span>
              </span>
              <button
                type="button"
                onClick={async () => {
                  handleClose();
                  await logout();
                }}
                title={t("settings.profile.sign_out") || "Log out"}
                aria-label={t("settings.profile.sign_out") || "Log out"}
                className="p-1.5 rounded-md text-text-tertiary hover:text-[#E81123] hover:bg-border-alpha-14 transition-colors border-0 bg-transparent cursor-pointer flex items-center justify-center shrink-0"
              >
                <ExitLine size={18} className="shrink-0" />
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
