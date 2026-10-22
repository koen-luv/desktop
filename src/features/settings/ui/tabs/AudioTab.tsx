import { useState, useEffect } from "react";
import { FolderOpenLine } from "@mingcute/react";
import { useToast } from "@/shared/ui";
import Button from "@/shared/ui/Button";
import { useTranslation } from "@/languages";
import { usePlayerStore, type AudioQuality } from "@/features/player";
import { Select } from "@/shared/ui";
import { useConnectivityStore } from "@/features/connectivity";
import { SettingRow, SettingSection } from "../controls";

export function AudioTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const { toast } = useToast();
  const [dumpExported, setDumpExported] = useState(false);
  const audioQuality = usePlayerStore((state) => state.audioQuality);
  const setAudioQuality = usePlayerStore((state) => state.setAudioQuality);
  const connRunning = useConnectivityStore((s) => s.running);
  const connChecks = useConnectivityStore((s) => s.checks);
  const connLastRunAt = useConnectivityStore((s) => s.lastRunAt);
  const runAndSaveDump = useConnectivityStore((s) => s.runAndSaveDump);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Lossless asks the playback session for the FLAC/ALAC master; tracks without
  // one keep playing from the best available stream instead of failing.
  const quality: AudioQuality = audioQuality;
  const qualityDescription =
    quality === "lossless"
      ? t("settings.audio.lossless_description") ||
        "Plays the lossless master (FLAC/ALAC) when Liner has one; other tracks use the best available stream."
      : t("settings.audio.description");

  return (
    <div className="flex flex-col gap-[16px]">
      <SettingSection>
        <SettingRow
          title={t("settings.audio.title")}
          description={qualityDescription}
          titleKey="settings.audio.title"
          descKey="settings.audio.description"
          searchQuery={searchQuery}
          control={
            mounted ? (
              <Select
                aria-label={t("settings.audio.title")}
                className="w-[210px]"
                value={quality}
                onChange={setAudioQuality}
                options={[
                  { value: "low", label: t("settings.audio.low") },
                  { value: "standard", label: t("settings.audio.standard") },
                  { value: "high", label: t("settings.audio.high") },
                  { value: "lossless", label: t("settings.audio.lossless") },
                ]}
              />
            ) : (
              <span />
            )
          }
        />
      </SettingSection>

      <SettingSection label={t("settings.connection.title")}>
        <SettingRow
          title={t("settings.connection.checks_title")}
          titleKey="settings.connection.checks_title"
          searchQuery={searchQuery}
          description={
            connChecks.length > 0 && connLastRunAt
              ? t("settings.connection.last_run", {
                  ok: connChecks.filter((c) => c.status === "ok").length,
                  total: connChecks.length,
                  time: new Date(connLastRunAt).toLocaleTimeString(),
                })
              : t("settings.connection.never_run")
          }
          control={
            <div className="flex items-center gap-[8px]">
              {dumpExported && (
                <Button
                  variant="secondary"
                  type="button"
                  onClick={async () => {
                    const targetPath = useConnectivityStore.getState().lastSavedDumpPath || undefined;
                    if (window.linerElectron?.openExportFolder) {
                      await window.linerElectron.openExportFolder(targetPath);
                    } else if (window.linerElectron?.openDownloads) {
                      await window.linerElectron.openDownloads(targetPath);
                    } else {
                      toast(t("settings.connection.open_folder"), "info");
                    }
                  }}
                  title={t("settings.connection.open_folder")}
                  aria-label={t("settings.connection.open_folder")}
                  className="!h-[34px] !w-[34px] !px-0"
                >
                  <FolderOpenLine size={18} />
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={connRunning}
                onClick={async () => {
                  const res = await runAndSaveDump();
                  if (res.success) {
                    setDumpExported(true);
                    toast(t("settings.connection.saved"), "success");
                  } else if (!res.canceled) {
                    toast(t("settings.connection.failed"), "error");
                  }
                }}
              >
                {connRunning
                  ? t("settings.connection.checking")
                  : t("settings.connection.button")}
              </Button>
            </div>
          }
        />
      </SettingSection>
    </div>
  );
}
