import { useState, useEffect } from "react";
import { useTranslation } from "@/languages";
import { usePlayerStore, downloadTrack } from "@/features/player";
import { ToggleSwitch, Select, useToast } from "@/shared/ui";
import Button from "@/shared/ui/Button";
import { SettingRow, SettingSection, SegmentedControl } from "../controls";
import {
  TRANSITION_PRESET_IDS,
  type TransitionPreset,
} from "@/features/player/engine/transitions";

export function PlaybackTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const { toast } = useToast();
  const autoplaySimilar = usePlayerStore((state) => state.autoplaySimilar);
  const setAutoplaySimilar = usePlayerStore(
    (state) => state.setAutoplaySimilar,
  );
  const trackDoubleClickBehavior = usePlayerStore(
    (state) => state.trackDoubleClickBehavior,
  );
  const setTrackDoubleClickBehavior = usePlayerStore(
    (state) => state.setTrackDoubleClickBehavior,
  );
  const defaultPlaybackContext = usePlayerStore(
    (state) => state.defaultPlaybackContext,
  );
  const setDefaultPlaybackContext = usePlayerStore(
    (state) => state.setDefaultPlaybackContext,
  );
  const pauseOnDeviceChange = usePlayerStore(
    (state) => state.pauseOnDeviceChange,
  );
  const setPauseOnDeviceChange = usePlayerStore(
    (state) => state.setPauseOnDeviceChange,
  );
  const transitionPreset = usePlayerStore((state) => state.transitionPreset);
  const setTransitionPreset = usePlayerStore(
    (state) => state.setTransitionPreset,
  );
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <SettingSection>

      <SettingRow
        title={t("settings.autoplay_similar.title")}
        description={t("settings.autoplay_similar.description")}
        titleKey="settings.autoplay_similar.title"
        descKey="settings.autoplay_similar.description"
        searchQuery={searchQuery}
        control={
          <ToggleSwitch
            checked={autoplaySimilar}
            onChange={setAutoplaySimilar}
          />
        }
      />

      <SettingRow
        title={t("settings.track_double_click.title")}
        description={t("settings.track_double_click.description")}
        titleKey="settings.track_double_click.title"
        descKey="settings.track_double_click.description"
        searchQuery={searchQuery}
        control={
          mounted ? (
            <SegmentedControl
              ariaLabel={t("settings.track_double_click.title")}
              value={trackDoubleClickBehavior}
              onChange={setTrackDoubleClickBehavior}
              options={[
                {
                  value: "play",
                  label: t("settings.track_double_click.play"),
                },
                {
                  value: "queue",
                  label: t("settings.track_double_click.queue"),
                },
              ]}
            />
          ) : (
            <span />
          )
        }
      />

      <SettingRow
        title={t("settings.default_playback_context.title")}
        description={t("settings.default_playback_context.description")}
        titleKey="settings.default_playback_context.title"
        descKey="settings.default_playback_context.description"
        searchQuery={searchQuery}
        control={
          mounted ? (
            <SegmentedControl
              ariaLabel={t("settings.default_playback_context.title")}
              value={defaultPlaybackContext}
              onChange={setDefaultPlaybackContext}
              options={[
                {
                  value: "resume",
                  label: t("settings.default_playback_context.resume"),
                },
                {
                  value: "empty",
                  label: t("settings.default_playback_context.empty"),
                },
              ]}
            />
          ) : (
            <span />
          )
        }
      />

      <SettingRow
        title={t("settings.transitions.title")}
        description={t("settings.transitions.description")}
        titleKey="settings.transitions.title"
        descKey="settings.transitions.description"
        searchQuery={searchQuery}
        control={
          mounted ? (
            <Select<TransitionPreset>
              aria-label={t("settings.transitions.title")}
              value={transitionPreset}
              onChange={setTransitionPreset}
              options={TRANSITION_PRESET_IDS.map((preset) => ({
                value: preset,
                label: t(`settings.transitions.${preset}`),
              }))}
            />
          ) : (
            <span />
          )
        }
      />

      <SettingRow
        title={t("settings.audio.pause_on_device_change.title")}
        description={t("settings.audio.pause_on_device_change.description")}
        titleKey="settings.audio.pause_on_device_change.title"
        descKey="settings.audio.pause_on_device_change.description"
        searchQuery={searchQuery}
        control={
          <ToggleSwitch
            checked={pauseOnDeviceChange}
            onChange={setPauseOnDeviceChange}
          />
        }
      />

      <SettingRow
        title={t("settings.audio.download_current_song.title")}
        description={t("settings.audio.download_current_song.description")}
        titleKey="settings.audio.download_current_song.title"
        descKey="settings.audio.download_current_song.description"
        searchQuery={searchQuery}
        control={
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={!currentTrack || downloading}
            title={t("common.download")}
            aria-label={t("common.download")}
            onClick={async () => {
              if (!currentTrack || downloading) return;
              setDownloading(true);
              try {
                const result = await downloadTrack(currentTrack);
                if (result.success) {
                  const name = `${currentTrack.title}${
                    currentTrack.artists ? ` — ${currentTrack.artists}` : ""
                  }`;
                  toast(`Saved: ${name}`, "success");
                } else {
                  toast(`Download failed: ${result.error}`, "error");
                }
              } finally {
                setDownloading(false);
              }
            }}
          >
            {t("common.download")}
          </Button>
        }
      />
    </SettingSection>
  );
}
