import { useState, useEffect } from "react";
import { useTranslation } from "@/languages";
import {
  useDiscordCloudStore,
  useDiscordSettingsStore,
  type DiscordStatusDisplayType,
} from "@/features/discord";
import { Button, ToggleSwitch, Select } from "@/shared/ui";
import { SettingRow, SettingSection } from "../controls";

export function DiscordTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const [discordStatus, setDiscordStatus] = useState<{
    connected: boolean;
    username?: string;
  }>({ connected: false });

  const enabled = useDiscordSettingsStore((s) => s.enabled);
  const setEnabled = useDiscordSettingsStore((s) => s.setEnabled);

  const cloudMode = useDiscordCloudStore((s) => s.mode);
  const cloudLinked = useDiscordCloudStore((s) => s.linked);
  const cloudUsername = useDiscordCloudStore((s) => s.username);
  const cloudLinking = useDiscordCloudStore((s) => s.linking);
  const cloudError = useDiscordCloudStore((s) => s.error);
  const startCloudLink = useDiscordCloudStore((s) => s.startLink);
  const unlinkCloud = useDiscordCloudStore((s) => s.unlink);

  // A linked account is served from the backend, so it counts as connected even
  // when this device has no local Discord client (always the case on phones).
  const connected = cloudLinked || discordStatus.connected;
  const connectedUser = cloudLinked ? cloudUsername : discordStatus.username;
  const cloudErrorText =
    cloudError === "expired"
      ? t("settings.discord.cloud.error_expired") || "The sign-in expired. Try again."
      : cloudError === "failed"
        ? t("settings.discord.cloud.error_failed") || "Discord sign-in failed. Try again."
        : "";

  const statusDisplayType = useDiscordSettingsStore((s) => s.statusDisplayType);
  const setStatusDisplayType = useDiscordSettingsStore((s) => s.setStatusDisplayType);

  const showTime = useDiscordSettingsStore((s) => s.showTime);
  const setShowTime = useDiscordSettingsStore((s) => s.setShowTime);

  const showArtwork = useDiscordSettingsStore((s) => s.showArtwork);
  const setShowArtwork = useDiscordSettingsStore((s) => s.setShowArtwork);

  const showArtistSmallImage = useDiscordSettingsStore((s) => s.showArtistSmallImage);
  const setShowArtistSmallImage = useDiscordSettingsStore((s) => s.setShowArtistSmallImage);

  const showPaused = useDiscordSettingsStore((s) => s.showPaused);
  const setShowPaused = useDiscordSettingsStore((s) => s.setShowPaused);

  const showButton = useDiscordSettingsStore((s) => s.showButton);
  const setShowButton = useDiscordSettingsStore((s) => s.setShowButton);

  const showDownloadButton = useDiscordSettingsStore((s) => s.showDownloadButton);
  const setShowDownloadButton = useDiscordSettingsStore((s) => s.setShowDownloadButton);

  useEffect(() => {
    setMounted(true);

    const checkStatus = () => {
      if (window.linerElectron?.getDiscordStatus) {
        window.linerElectron.getDiscordStatus().then((status) => {
          if (status) setDiscordStatus(status);
        });
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Linked account: the only path that reaches Discord from a phone */}
      {cloudMode !== "unknown" && (
        <SettingSection label={t("settings.discord.cloud.section") || "Discord Account"}>
          <SettingRow
            title={
              cloudLinked
                ? t("settings.discord.cloud.linked", { user: cloudUsername || "Discord" }) ||
                  `Linked as ${cloudUsername || "Discord"}`
                : t("settings.discord.cloud.title") || "Link your Discord account"
            }
            description={
              cloudMode === "unavailable"
                ? t("settings.discord.cloud.unavailable") ||
                  "This server doesn't support cloud Discord presence yet."
                : cloudLinking
                  ? t("settings.discord.cloud.waiting") || "Finish the sign-in in your browser…"
                  : cloudLinked
                    ? t("settings.discord.cloud.linked_hint") ||
                      "Liner updates your Discord activity from the cloud, on every device."
                    : t("settings.discord.cloud.description") ||
                      "Link Discord once so your activity also shows when you listen on your phone."
            }
            titleKey="settings.discord.cloud.title"
            descKey="settings.discord.cloud.description"
            searchQuery={searchQuery}
            control={
              cloudMode === "available" ? (
                cloudLinked ? (
                  <Button variant="outline" size="sm" onClick={() => void unlinkCloud()}>
                    {t("settings.discord.cloud.unlink") || "Unlink"}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={cloudLinking}
                    onClick={() => void startCloudLink()}
                  >
                    {cloudLinking
                      ? t("settings.discord.cloud.waiting_button") || "Waiting…"
                      : t("settings.discord.cloud.link") || "Link Discord account"}
                  </Button>
                )
              ) : undefined
            }
          />
          {cloudErrorText ? (
            <div className="mx-[14px] mb-[10px] px-[10px] py-[8px] rounded-lg bg-red-500/10 text-[12px] text-red-400 break-words">
              {cloudErrorText}
            </div>
          ) : null}
        </SettingSection>
      )}

      {/* Discord Connection Status */}
      <div className="flex items-center justify-between px-[14px] py-[10px] rounded-lg bg-border-alpha-10">
        <div className="flex items-center gap-[10px]">
          <span
            className={`w-[8px] h-[8px] rounded-full shrink-0 ${
              connected
                ? "bg-[#23a55a] shadow-[0_0_8px_rgba(35,165,90,0.5)]"
                : "bg-text-tertiary/40"
            }`}
          />
          <span className="text-[13px] text-text-primary font-medium">
            {connected
              ? t("settings.discord.status.connected", {
                  user: connectedUser || "Discord",
                }) || `Connected to Discord (${connectedUser || "Active"})`
              : t("settings.discord.status.disconnected") || "Discord not connected"}
          </span>
        </div>
        <span className="text-[12px] text-text-tertiary font-mono">
          {enabled
            ? connected
              ? t("settings.discord.status.ready") || "Ready"
              : t("settings.discord.status.waiting") || "Waiting for Discord"
            : t("settings.discord.status.disabled") || "Disabled"}
        </span>
      </div>

      {/* Main enable switch */}
      <SettingSection>
        <SettingRow
          title={t("settings.discord.enable.title") || "Discord Rich Presence"}
          description={
            t("settings.discord.enable.description") ||
            "Broadcast your active music playback to your Discord profile."
          }
          titleKey="settings.discord.enable.title"
          descKey="settings.discord.enable.description"
          searchQuery={searchQuery}
          control={
            <ToggleSwitch
              checked={enabled}
              onChange={setEnabled}
            />
          }
        />
      </SettingSection>

      {/* Display Options */}
      <SettingSection label={t("settings.discord.section_display") || "Display Options"}>
        {/* Status Line Format */}
        <SettingRow
          title={t("settings.discord.status_display.title") || "Status Format"}
          description={
            t("settings.discord.status_display.description") ||
            "Choose what appears in Discord's 'Listening to...' status header."
          }
          titleKey="settings.discord.status_display.title"
          descKey="settings.discord.status_display.description"
          searchQuery={searchQuery}
          control={
            mounted ? (
              <Select<DiscordStatusDisplayType>
                aria-label={t("settings.discord.status_display.title") || "Status Format"}
                className="w-[210px]"
                value={statusDisplayType}
                onChange={setStatusDisplayType}
                disabled={!enabled}
                options={[
                  {
                    value: "artist",
                    label: t("settings.discord.status_display.artist") || "Artist (Default)",
                  },
                  {
                    value: "title",
                    label: t("settings.discord.status_display.song") || "Song Title",
                  },
                  {
                    value: "artist_title",
                    label: t("settings.discord.status_display.artist_song") || "Artist - Song",
                  },
                  {
                    value: "title_artist",
                    label: t("settings.discord.status_display.song_artist") || "Song - Artist",
                  },
                  {
                    value: "app",
                    label: t("settings.discord.status_display.app") || "Liner (App name)",
                  },
                ]}
              />
            ) : (
              <span />
            )
          }
        />

        {/* Timeline progress bar */}
        <SettingRow
          title={t("settings.discord.show_timeline.title") || "Playback Timeline"}
          description={
            t("settings.discord.show_timeline.description") ||
            "Display interactive progress bar with elapsed and remaining track time."
          }
          titleKey="settings.discord.show_timeline.title"
          descKey="settings.discord.show_timeline.description"
          searchQuery={searchQuery}
          control={
            <ToggleSwitch
              checked={showTime}
              onChange={setShowTime}
              disabled={!enabled}
            />
          }
        />

        {/* Track artwork */}
        <SettingRow
          title={t("settings.discord.show_artwork.title") || "Track Artwork"}
          description={
            t("settings.discord.show_artwork.description") ||
            "Show track or album cover in the Discord activity card."
          }
          titleKey="settings.discord.show_artwork.title"
          descKey="settings.discord.show_artwork.description"
          searchQuery={searchQuery}
          control={
            <ToggleSwitch
              checked={showArtwork}
              onChange={setShowArtwork}
              disabled={!enabled}
            />
          }
        />

        {/* Artist small image */}
        <SettingRow
          title={t("settings.discord.show_artist_image.title") || "Artist Photo Badge"}
          description={
            t("settings.discord.show_artist_image.description") ||
            "Display the artist photo in a small circular badge on the bottom corner."
          }
          titleKey="settings.discord.show_artist_image.title"
          descKey="settings.discord.show_artist_image.description"
          searchQuery={searchQuery}
          control={
            <ToggleSwitch
              checked={showArtistSmallImage}
              onChange={setShowArtistSmallImage}
              disabled={!enabled}
            />
          }
        />

        {/* Show when paused */}
        <SettingRow
          title={t("settings.discord.show_paused.title") || "Show when Paused"}
          description={
            t("settings.discord.show_paused.description") ||
            "Keep status visible on Discord with a paused indicator when music is paused."
          }
          titleKey="settings.discord.show_paused.title"
          descKey="settings.discord.show_paused.description"
          searchQuery={searchQuery}
          control={
            <ToggleSwitch
              checked={showPaused}
              onChange={setShowPaused}
              disabled={!enabled}
            />
          }
        />
      </SettingSection>

      {/* Profile Buttons */}
      <SettingSection label={t("settings.discord.section_buttons") || "Profile Buttons"}>
        {/* Listen on Liner button */}
        <SettingRow
          title={t("settings.discord.show_button.title") || "'Listen on Liner' Button"}
          description={
            t("settings.discord.show_button.description") ||
            "Add an interactive button linking to the song on Liner."
          }
          titleKey="settings.discord.show_button.title"
          descKey="settings.discord.show_button.description"
          searchQuery={searchQuery}
          control={
            <ToggleSwitch
              checked={showButton}
              onChange={setShowButton}
              disabled={!enabled}
            />
          }
        />

        {/* Download Liner button */}
        <SettingRow
          title={t("settings.discord.show_download_button.title") || "'Download Liner' Button"}
          description={
            t("settings.discord.show_download_button.description") ||
            "Add an interactive button linking to tryliner.fun to download the app."
          }
          titleKey="settings.discord.show_download_button.title"
          descKey="settings.discord.show_download_button.description"
          searchQuery={searchQuery}
          control={
            <ToggleSwitch
              checked={showDownloadButton}
              onChange={setShowDownloadButton}
              disabled={!enabled}
            />
          }
        />
      </SettingSection>
    </div>
  );
}
