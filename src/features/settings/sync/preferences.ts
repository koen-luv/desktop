import type { Locale } from "@/languages";
import { SUPPORTED_LOCALES } from "@/languages/locale";
import {
  useCustomizationStore,
  clampBlockConfig,
  normalizePlayerElementOrder,
  type BlockCustomization,
  type CustomizationState,
  type PlayerElementId,
} from "../store/customizationStore";
import {
  usePlayerStore,
  type AccentVariant,
  type AudioQuality,
  type DefaultPlaybackContext,
  type MiniPlayerStyle,
  type PlayerStore,
  type RepeatMode,
  type TrackDoubleClickBehavior,
} from "@/features/player/store/playerStore";
import {
  isTransitionPreset,
  type TransitionPreset,
} from "@/features/player/engine/transitions";
import { normalizeEqualizerGains } from "@/features/player/engine/equalizer";
import { useEqualizerSettingsStore } from "@/features/player/store/equalizerSettingsStore";
import { useShortcutsStore } from "@/features/shortcuts/store/shortcutsStore";
import {
  DEFAULT_SHORTCUTS,
  type GlobalShortcutsSettings,
  type MainAppShortcutsSettings,
  type MiniplayerShortcutsSettings,
} from "@/features/shortcuts/types";
import { useOverlaySettingsStore } from "@/features/overlay/store/overlaySettingsStore";
import type {
  OverlayPosition,
  OverlaySettings,
} from "@/features/overlay/contracts";
import { useDiscordSettingsStore } from "@/features/discord/store/discordSettingsStore";
import type {
  DiscordRpcSettings,
  DiscordStatusDisplayType,
} from "@/features/discord/contracts";
import { useLastfmSettingsStore } from "@/features/lastfm/store/lastfmSettingsStore";

export const PREFERENCES_VERSION = 1;

export type SyncedTheme = "light" | "dark" | "system";

export interface SyncedAppearance {
  backgroundBlur: number;
  backgroundDim: number;
  backgroundOpacity: number;
  useWallpaperInFullscreen: boolean;
  fullscreenPlainBackground: boolean;
  cinematicMode: boolean;
  sidebar: BlockCustomization;
  contentView: BlockCustomization;
  miniplayer: BlockCustomization;
  playerElementOrder: PlayerElementId[];
}

export interface SyncedPlayback {
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  audioQuality: AudioQuality;
  miniPlayerStyle: MiniPlayerStyle;
  accentVariant: AccentVariant;
  pauseOnDeviceChange: boolean;
  autoplaySimilar: boolean;
  trackDoubleClickBehavior: TrackDoubleClickBehavior;
  defaultPlaybackContext: DefaultPlaybackContext;
  playbackRate: number;
  pitchSemitones: number;
  isPitchLinked: boolean;
  keepSpeedAcrossTracks: boolean;
  isReverbEnabled: boolean;
  reverbLevel: number;
  transitionPreset: TransitionPreset;
}

export interface SyncedEqualizer {
  enabled: boolean;
  gains: number[];
}

export interface SyncedShortcuts {
  global: GlobalShortcutsSettings;
  mainApp: MainAppShortcutsSettings;
  miniplayer: MiniplayerShortcutsSettings;
}

export interface SyncedLastfm {
  enabled: boolean;
}

export interface SyncedPreferences {
  version: typeof PREFERENCES_VERSION;
  theme: SyncedTheme;
  locale: Locale;
  appearance: SyncedAppearance;
  playback: SyncedPlayback;
  equalizer: SyncedEqualizer;
  shortcuts: SyncedShortcuts;
  overlay: OverlaySettings;
  discord: DiscordRpcSettings;
  lastfm: SyncedLastfm;
}

type PartialShortcuts = {
  global?: Partial<GlobalShortcutsSettings>;
  mainApp?: Partial<MainAppShortcutsSettings>;
  miniplayer?: Partial<MiniplayerShortcutsSettings>;
};

export type PartialSyncedPreferences = {
  version?: number;
  theme?: SyncedTheme;
  locale?: Locale;
  appearance?: Partial<SyncedAppearance>;
  playback?: Partial<SyncedPlayback>;
  equalizer?: Partial<SyncedEqualizer>;
  shortcuts?: PartialShortcuts;
  overlay?: Partial<OverlaySettings>;
  discord?: Partial<DiscordRpcSettings>;
  lastfm?: Partial<SyncedLastfm>;
};

const THEME_VALUES: SyncedTheme[] = ["light", "dark", "system"];
const REPEAT_MODES: RepeatMode[] = ["off", "all", "one"];
const AUDIO_QUALITIES: AudioQuality[] = ["low", "standard", "high", "lossless"];
const MINI_PLAYER_STYLES: MiniPlayerStyle[] = ["default", "rounded"];
const TRACK_DOUBLE_CLICK_BEHAVIORS: TrackDoubleClickBehavior[] = ["play", "queue"];
const DEFAULT_PLAYBACK_CONTEXTS: DefaultPlaybackContext[] = ["resume", "empty"];
const ACCENT_VARIANTS: AccentVariant[] = [
  "default",
  "spotify",
  "discord",
  "telegram",
  "aurora",
  "sunset",
  "ocean",
  "forest",
  "berry",
  "carbon",
  "pixel",
  "scanlines",
  "vhs",
];
const OVERLAY_POSITIONS: OverlayPosition[] = [
  "top-left",
  "top-center",
  "top-right",
];
const DISCORD_STATUS_TYPES: DiscordStatusDisplayType[] = [
  "artist",
  "title",
  "artist_title",
  "title_artist",
  "app",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseBlock(value: unknown): BlockCustomization | undefined {
  if (!isRecord(value)) return undefined;
  return clampBlockConfig(value);
}

function parseAppearance(value: unknown): Partial<SyncedAppearance> {
  if (!isRecord(value)) return {};
  const result: Partial<SyncedAppearance> = {};

  const backgroundBlur = numberIn(value.backgroundBlur, 0, 40);
  if (backgroundBlur !== undefined) result.backgroundBlur = Math.round(backgroundBlur);
  const backgroundDim = numberIn(value.backgroundDim, 0, 85);
  if (backgroundDim !== undefined) result.backgroundDim = Math.round(backgroundDim);
  const backgroundOpacity = numberIn(value.backgroundOpacity, 0, 100);
  if (backgroundOpacity !== undefined) {
    result.backgroundOpacity = Math.round(backgroundOpacity);
  }

  const useWallpaperInFullscreen = booleanValue(value.useWallpaperInFullscreen);
  if (useWallpaperInFullscreen !== undefined) {
    result.useWallpaperInFullscreen = useWallpaperInFullscreen;
  }
  const fullscreenPlainBackground = booleanValue(value.fullscreenPlainBackground);
  if (fullscreenPlainBackground !== undefined) {
    result.fullscreenPlainBackground = fullscreenPlainBackground;
  }
  const cinematicMode = booleanValue(value.cinematicMode);
  if (cinematicMode !== undefined) result.cinematicMode = cinematicMode;

  const sidebar = parseBlock(value.sidebar);
  if (sidebar) result.sidebar = sidebar;
  const contentView = parseBlock(value.contentView);
  if (contentView) result.contentView = contentView;
  const miniplayer = parseBlock(value.miniplayer);
  if (miniplayer) result.miniplayer = miniplayer;

  if (Array.isArray(value.playerElementOrder)) {
    result.playerElementOrder = normalizePlayerElementOrder(value.playerElementOrder);
  }

  return result;
}

function parsePlayback(value: unknown): Partial<SyncedPlayback> {
  if (!isRecord(value)) return {};
  const result: Partial<SyncedPlayback> = {};

  const volume = numberIn(value.volume, 0, 1);
  if (volume !== undefined) result.volume = volume;
  const repeat = oneOf(value.repeat, REPEAT_MODES);
  if (repeat) result.repeat = repeat;
  const shuffle = booleanValue(value.shuffle);
  if (shuffle !== undefined) result.shuffle = shuffle;
  const audioQuality = oneOf(value.audioQuality, AUDIO_QUALITIES);
  if (audioQuality) result.audioQuality = audioQuality;
  const miniPlayerStyle = oneOf(value.miniPlayerStyle, MINI_PLAYER_STYLES);
  if (miniPlayerStyle) result.miniPlayerStyle = miniPlayerStyle;
  const accentVariant = oneOf(value.accentVariant, ACCENT_VARIANTS);
  if (accentVariant) result.accentVariant = accentVariant;
  const pauseOnDeviceChange = booleanValue(value.pauseOnDeviceChange);
  if (pauseOnDeviceChange !== undefined) result.pauseOnDeviceChange = pauseOnDeviceChange;
  const autoplaySimilar = booleanValue(value.autoplaySimilar);
  if (autoplaySimilar !== undefined) result.autoplaySimilar = autoplaySimilar;
  const trackDoubleClickBehavior = oneOf(
    value.trackDoubleClickBehavior,
    TRACK_DOUBLE_CLICK_BEHAVIORS,
  );
  if (trackDoubleClickBehavior) {
    result.trackDoubleClickBehavior = trackDoubleClickBehavior;
  }
  const defaultPlaybackContext = oneOf(
    value.defaultPlaybackContext,
    DEFAULT_PLAYBACK_CONTEXTS,
  );
  if (defaultPlaybackContext) result.defaultPlaybackContext = defaultPlaybackContext;
  const playbackRate = numberIn(value.playbackRate, 0.25, 4);
  if (playbackRate !== undefined) result.playbackRate = playbackRate;
  const pitchSemitones = numberIn(value.pitchSemitones, -24, 24);
  if (pitchSemitones !== undefined) result.pitchSemitones = pitchSemitones;
  const isPitchLinked = booleanValue(value.isPitchLinked);
  if (isPitchLinked !== undefined) result.isPitchLinked = isPitchLinked;
  const keepSpeedAcrossTracks = booleanValue(value.keepSpeedAcrossTracks);
  if (keepSpeedAcrossTracks !== undefined) {
    result.keepSpeedAcrossTracks = keepSpeedAcrossTracks;
  }
  const isReverbEnabled = booleanValue(value.isReverbEnabled);
  if (isReverbEnabled !== undefined) result.isReverbEnabled = isReverbEnabled;
  const reverbLevel = numberIn(value.reverbLevel, 0, 1);
  if (reverbLevel !== undefined) result.reverbLevel = reverbLevel;

  if (typeof value.transitionPreset === "string" && isTransitionPreset(value.transitionPreset)) {
    result.transitionPreset = value.transitionPreset;
  }

  return result;
}

function parseEqualizer(value: unknown): Partial<SyncedEqualizer> {
  if (!isRecord(value)) return {};
  const result: Partial<SyncedEqualizer> = {};
  const enabled = booleanValue(value.enabled);
  if (enabled !== undefined) result.enabled = enabled;
  if (Array.isArray(value.gains)) {
    result.gains = normalizeEqualizerGains(value.gains);
  }
  return result;
}

function parseShortcuts(value: unknown): PartialShortcuts {
  if (!isRecord(value)) return {};
  const result: PartialShortcuts = {};

  const parseScope = <T extends object>(
    scope: unknown,
    defaults: T,
  ): Partial<T> | undefined => {
    if (!isRecord(scope)) return undefined;
    const parsed: Partial<Record<keyof T, string>> = {};
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      const shortcut = nonEmptyString(scope[key as string]);
      if (shortcut) parsed[key] = shortcut;
    }
    return Object.keys(parsed).length > 0 ? (parsed as Partial<T>) : undefined;
  };

  const global = parseScope(value.global, DEFAULT_SHORTCUTS.global);
  if (global) result.global = global;
  const mainApp = parseScope(value.mainApp, DEFAULT_SHORTCUTS.mainApp);
  if (mainApp) result.mainApp = mainApp;
  const miniplayer = parseScope(value.miniplayer, DEFAULT_SHORTCUTS.miniplayer);
  if (miniplayer) result.miniplayer = miniplayer;

  return result;
}

function parseOverlay(value: unknown): Partial<OverlaySettings> {
  if (!isRecord(value)) return {};
  const result: Partial<OverlaySettings> = {};

  const enabled = booleanValue(value.enabled);
  if (enabled !== undefined) result.enabled = enabled;
  const position = oneOf(value.position, OVERLAY_POSITIONS);
  if (position) result.position = position;
  const shortcut = nonEmptyString(value.shortcut);
  if (shortcut) result.shortcut = shortcut;
  const autoShowOnMinimize = booleanValue(value.autoShowOnMinimize);
  if (autoShowOnMinimize !== undefined) result.autoShowOnMinimize = autoShowOnMinimize;
  const alwaysOnTop = booleanValue(value.alwaysOnTop);
  if (alwaysOnTop !== undefined) result.alwaysOnTop = alwaysOnTop;

  return result;
}

function parseDiscord(value: unknown): Partial<DiscordRpcSettings> {
  if (!isRecord(value)) return {};
  const result: Partial<DiscordRpcSettings> = {};

  const enabled = booleanValue(value.enabled);
  if (enabled !== undefined) result.enabled = enabled;
  const statusDisplayType = oneOf(value.statusDisplayType, DISCORD_STATUS_TYPES);
  if (statusDisplayType) result.statusDisplayType = statusDisplayType;
  for (const key of [
    "showArtwork",
    "showArtistSmallImage",
    "showTime",
    "showPaused",
    "showButton",
    "showDownloadButton",
  ] as const) {
    const flag = booleanValue(value[key]);
    if (flag !== undefined) result[key] = flag;
  }

  return result;
}

function parseLastfm(value: unknown): Partial<SyncedLastfm> {
  if (!isRecord(value)) return {};
  const enabled = booleanValue(value.enabled);
  return enabled === undefined ? {} : { enabled };
}

export function parseSyncedPreferences(value: unknown): PartialSyncedPreferences {
  if (!isRecord(value)) return {};
  const result: PartialSyncedPreferences = {};

  if (typeof value.version === "number") result.version = value.version;
  const theme = oneOf(value.theme, THEME_VALUES);
  if (theme) result.theme = theme;
  const locale = oneOf(value.locale, SUPPORTED_LOCALES);
  if (locale) result.locale = locale;

  const appearance = parseAppearance(value.appearance);
  if (Object.keys(appearance).length > 0) result.appearance = appearance;
  const playback = parsePlayback(value.playback);
  if (Object.keys(playback).length > 0) result.playback = playback;
  const equalizer = parseEqualizer(value.equalizer);
  if (Object.keys(equalizer).length > 0) result.equalizer = equalizer;
  const shortcuts = parseShortcuts(value.shortcuts);
  if (Object.keys(shortcuts).length > 0) result.shortcuts = shortcuts;
  const overlay = parseOverlay(value.overlay);
  if (Object.keys(overlay).length > 0) result.overlay = overlay;
  const discord = parseDiscord(value.discord);
  if (Object.keys(discord).length > 0) result.discord = discord;
  const lastfm = parseLastfm(value.lastfm);
  if (Object.keys(lastfm).length > 0) result.lastfm = lastfm;

  return result;
}

export function hasPreferenceContent(value: PartialSyncedPreferences): boolean {
  return Object.entries(value).some(([key, entry]) => {
    if (key === "version" || entry === undefined) return false;
    if (isRecord(entry)) return Object.keys(entry).length > 0;
    return true;
  });
}

export function buildPreferencesSnapshot(
  theme: SyncedTheme,
  locale: Locale,
): SyncedPreferences {
  const appearance = useCustomizationStore.getState();
  const playback = usePlayerStore.getState();
  const equalizer = useEqualizerSettingsStore.getState();
  const shortcuts = useShortcutsStore.getState();
  const overlay = useOverlaySettingsStore.getState();
  const discord = useDiscordSettingsStore.getState();
  const lastfm = useLastfmSettingsStore.getState();

  return {
    version: PREFERENCES_VERSION,
    theme,
    locale,
    appearance: {
      backgroundBlur: appearance.backgroundBlur,
      backgroundDim: appearance.backgroundDim,
      backgroundOpacity: appearance.backgroundOpacity,
      useWallpaperInFullscreen: appearance.useWallpaperInFullscreen,
      fullscreenPlainBackground: appearance.fullscreenPlainBackground,
      cinematicMode: appearance.cinematicMode,
      sidebar: { ...appearance.sidebar },
      contentView: { ...appearance.contentView },
      miniplayer: { ...appearance.miniplayer },
      playerElementOrder: [...appearance.playerElementOrder],
    },
    playback: {
      volume: playback.volume,
      repeat: playback.repeat,
      shuffle: playback.shuffle,
      audioQuality: playback.audioQuality,
      miniPlayerStyle: playback.miniPlayerStyle,
      accentVariant: playback.accentVariant,
      pauseOnDeviceChange: playback.pauseOnDeviceChange,
      autoplaySimilar: playback.autoplaySimilar,
      trackDoubleClickBehavior: playback.trackDoubleClickBehavior,
      defaultPlaybackContext: playback.defaultPlaybackContext,
      playbackRate: playback.playbackRate,
      pitchSemitones: playback.pitchSemitones,
      isPitchLinked: playback.isPitchLinked,
      keepSpeedAcrossTracks: playback.keepSpeedAcrossTracks,
      isReverbEnabled: playback.isReverbEnabled,
      reverbLevel: playback.reverbLevel,
      transitionPreset: playback.transitionPreset,
    },
    equalizer: {
      enabled: equalizer.enabled,
      gains: [...equalizer.gains],
    },
    shortcuts: {
      global: { ...shortcuts.global },
      mainApp: { ...shortcuts.mainApp },
      miniplayer: { ...shortcuts.miniplayer },
    },
    overlay: {
      enabled: overlay.enabled,
      position: overlay.position,
      shortcut: overlay.shortcut,
      autoShowOnMinimize: overlay.autoShowOnMinimize,
      alwaysOnTop: overlay.alwaysOnTop,
    },
    discord: {
      enabled: discord.enabled,
      statusDisplayType: discord.statusDisplayType,
      showArtwork: discord.showArtwork,
      showArtistSmallImage: discord.showArtistSmallImage,
      showTime: discord.showTime,
      showPaused: discord.showPaused,
      showButton: discord.showButton,
      showDownloadButton: discord.showDownloadButton,
    },
    lastfm: {
      enabled: lastfm.enabled,
    },
  };
}

export function applySyncedPreferences(
  preferences: PartialSyncedPreferences,
  actions: {
    setTheme: (theme: SyncedTheme) => void;
    setLocale: (locale: Locale) => void;
  },
): void {
  if (preferences.theme) actions.setTheme(preferences.theme);
  if (preferences.locale) actions.setLocale(preferences.locale);

  const appearance = preferences.appearance;
  if (appearance) {
    const current = useCustomizationStore.getState();
    const patch: Partial<CustomizationState> = {};
    if (appearance.backgroundBlur !== undefined) {
      patch.backgroundBlur = Math.min(40, Math.max(0, Math.round(appearance.backgroundBlur)));
    }
    if (appearance.backgroundDim !== undefined) {
      patch.backgroundDim = Math.min(85, Math.max(0, Math.round(appearance.backgroundDim)));
    }
    if (appearance.backgroundOpacity !== undefined) {
      patch.backgroundOpacity = Math.min(
        100,
        Math.max(0, Math.round(appearance.backgroundOpacity)),
      );
    }
    if (appearance.useWallpaperInFullscreen !== undefined) {
      patch.useWallpaperInFullscreen = appearance.useWallpaperInFullscreen;
    }
    if (appearance.fullscreenPlainBackground !== undefined) {
      patch.fullscreenPlainBackground = appearance.fullscreenPlainBackground;
    }
    if (appearance.cinematicMode !== undefined) {
      patch.cinematicMode = appearance.cinematicMode;
    }
    if (appearance.sidebar) {
      patch.sidebar = clampBlockConfig({ ...current.sidebar, ...appearance.sidebar });
    }
    if (appearance.contentView) {
      patch.contentView = clampBlockConfig({
        ...current.contentView,
        ...appearance.contentView,
      });
    }
    if (appearance.miniplayer) {
      patch.miniplayer = clampBlockConfig({
        ...current.miniplayer,
        ...appearance.miniplayer,
      });
    }
    if (appearance.playerElementOrder) {
      patch.playerElementOrder = normalizePlayerElementOrder(
        appearance.playerElementOrder,
      );
    }
    if (Object.keys(patch).length > 0) useCustomizationStore.setState(patch);
  }

  const playback = preferences.playback;
  if (playback) {
    const patch: Partial<PlayerStore> = {};
    if (playback.volume !== undefined) {
      patch.volume = Math.min(1, Math.max(0, playback.volume));
    }
    if (playback.repeat !== undefined) patch.repeat = playback.repeat;
    if (playback.shuffle !== undefined) patch.shuffle = playback.shuffle;
    if (playback.audioQuality !== undefined) patch.audioQuality = playback.audioQuality;
    if (playback.miniPlayerStyle !== undefined) {
      patch.miniPlayerStyle = playback.miniPlayerStyle;
    }
    if (playback.accentVariant !== undefined) {
      patch.accentVariant = playback.accentVariant;
    }
    if (playback.pauseOnDeviceChange !== undefined) {
      patch.pauseOnDeviceChange = playback.pauseOnDeviceChange;
    }
    if (playback.autoplaySimilar !== undefined) {
      patch.autoplaySimilar = playback.autoplaySimilar;
    }
    if (playback.trackDoubleClickBehavior !== undefined) {
      patch.trackDoubleClickBehavior = playback.trackDoubleClickBehavior;
    }
    if (playback.defaultPlaybackContext !== undefined) {
      patch.defaultPlaybackContext = playback.defaultPlaybackContext;
    }
    if (playback.playbackRate !== undefined) patch.playbackRate = playback.playbackRate;
    if (playback.pitchSemitones !== undefined) {
      patch.pitchSemitones = playback.pitchSemitones;
    }
    if (playback.isPitchLinked !== undefined) {
      patch.isPitchLinked = playback.isPitchLinked;
    }
    if (playback.keepSpeedAcrossTracks !== undefined) {
      patch.keepSpeedAcrossTracks = playback.keepSpeedAcrossTracks;
    }
    if (playback.isReverbEnabled !== undefined) {
      patch.isReverbEnabled = playback.isReverbEnabled;
    }
    if (playback.reverbLevel !== undefined) {
      patch.reverbLevel = playback.reverbLevel;
    }
    if (playback.transitionPreset !== undefined) {
      patch.transitionPreset = playback.transitionPreset;
    }
    if (Object.keys(patch).length > 0) usePlayerStore.setState(patch);
  }

  if (preferences.equalizer) {
    const patch: Partial<SyncedEqualizer> = {};
    if (preferences.equalizer.enabled !== undefined) {
      patch.enabled = preferences.equalizer.enabled;
    }
    if (preferences.equalizer.gains) {
      patch.gains = normalizeEqualizerGains(preferences.equalizer.gains);
    }
    if (Object.keys(patch).length > 0) {
      useEqualizerSettingsStore.setState(patch);
    }
  }

  if (preferences.shortcuts) {
    const shortcuts = useShortcutsStore.getState();
    if (preferences.shortcuts.global) {
      for (const key of Object.keys(
        DEFAULT_SHORTCUTS.global,
      ) as (keyof GlobalShortcutsSettings)[]) {
        const value = preferences.shortcuts.global[key];
        if (typeof value === "string") shortcuts.setGlobalShortcut(key, value);
      }
    }
    if (preferences.shortcuts.mainApp) {
      for (const key of Object.keys(
        DEFAULT_SHORTCUTS.mainApp,
      ) as (keyof MainAppShortcutsSettings)[]) {
        const value = preferences.shortcuts.mainApp[key];
        if (typeof value === "string") shortcuts.setMainAppShortcut(key, value);
      }
    }
    if (preferences.shortcuts.miniplayer) {
      for (const key of Object.keys(
        DEFAULT_SHORTCUTS.miniplayer,
      ) as (keyof MiniplayerShortcutsSettings)[]) {
        const value = preferences.shortcuts.miniplayer[key];
        if (typeof value === "string") shortcuts.setMiniplayerShortcut(key, value);
      }
    }
  }

  if (preferences.overlay) {
    const overlay = useOverlaySettingsStore.getState();
    if (preferences.overlay.enabled !== undefined) {
      overlay.setEnabled(preferences.overlay.enabled);
    }
    if (preferences.overlay.position !== undefined) {
      overlay.setPosition(preferences.overlay.position);
    }
    if (preferences.overlay.shortcut !== undefined) {
      overlay.setShortcut(preferences.overlay.shortcut);
    }
    if (preferences.overlay.autoShowOnMinimize !== undefined) {
      overlay.setAutoShowOnMinimize(preferences.overlay.autoShowOnMinimize);
    }
    if (preferences.overlay.alwaysOnTop !== undefined) {
      overlay.setAlwaysOnTop(preferences.overlay.alwaysOnTop);
    }
  }

  if (preferences.discord) {
    const discord = useDiscordSettingsStore.getState();
    if (preferences.discord.enabled !== undefined) {
      discord.setEnabled(preferences.discord.enabled);
    }
    if (preferences.discord.statusDisplayType !== undefined) {
      discord.setStatusDisplayType(preferences.discord.statusDisplayType);
    }
    if (preferences.discord.showArtwork !== undefined) {
      discord.setShowArtwork(preferences.discord.showArtwork);
    }
    if (preferences.discord.showArtistSmallImage !== undefined) {
      discord.setShowArtistSmallImage(preferences.discord.showArtistSmallImage);
    }
    if (preferences.discord.showTime !== undefined) {
      discord.setShowTime(preferences.discord.showTime);
    }
    if (preferences.discord.showPaused !== undefined) {
      discord.setShowPaused(preferences.discord.showPaused);
    }
    if (preferences.discord.showButton !== undefined) {
      discord.setShowButton(preferences.discord.showButton);
    }
    if (preferences.discord.showDownloadButton !== undefined) {
      discord.setShowDownloadButton(preferences.discord.showDownloadButton);
    }
  }

  if (preferences.lastfm?.enabled !== undefined) {
    useLastfmSettingsStore.getState().setEnabled(preferences.lastfm.enabled);
  }
}
