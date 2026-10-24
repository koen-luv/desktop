import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/languages";
import {
  lastfmAuthorizeUrl,
  lastfmGetToken,
  resolveLastfmCredentials,
  useLastfmSettingsStore,
} from "@/features/lastfm";
import { nativeOpenExternal } from "@/platform";
import { Button, ToggleSwitch } from "@/shared/ui";
import { SettingRow, SettingSection } from "../controls";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Last.fm account setup: authorize through the out-of-band flow, then control
 * scrobbling. Liner's own Last.fm application is always used, so there are no
 * API credentials to paste. Works on Android and desktop — the authorization
 * page opens in the system browser via the native bridge.
 */
export function LastFmTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();

  const enabled = useLastfmSettingsStore((s) => s.enabled);
  const setEnabled = useLastfmSettingsStore((s) => s.setEnabled);
  const sessionKey = useLastfmSettingsStore((s) => s.sessionKey);
  const username = useLastfmSettingsStore((s) => s.username);
  const pendingToken = useLastfmSettingsStore((s) => s.pendingToken);
  const pendingTokenAt = useLastfmSettingsStore((s) => s.pendingTokenAt);
  const setPendingToken = useLastfmSettingsStore((s) => s.setPendingToken);
  const connect = useLastfmSettingsStore((s) => s.connect);
  const disconnect = useLastfmSettingsStore((s) => s.disconnect);

  const [busy, setBusy] = useState<"token" | "session" | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const connected = Boolean(sessionKey);
  // Liner's own Last.fm application — no user-provided credentials anymore.
  const credentials = resolveLastfmCredentials("", "");
  const authUrl = pendingToken ? lastfmAuthorizeUrl(credentials.apiKey, pendingToken) : null;

  const openAuthorization = async () => {
    setBusy("token");
    setAuthError(null);
    try {
      const token = await lastfmGetToken(credentials);
      setPendingToken(token);
      const url = lastfmAuthorizeUrl(credentials.apiKey, token);
      // Android opens the system browser; desktop/web open a new window.
      // The link stays rendered as well, in case the popup was blocked.
      if (!nativeOpenExternal(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const finishConnecting = useCallback(async () => {
    if (!pendingToken) return;
    setBusy("session");
    setAuthError(null);
    try {
      await connect(pendingToken);
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [pendingToken, connect]);

  /**
   * The Last.fm approval happens in the system browser, so the settings tab —
   * or the whole WebView — can be unmounted while the user is away. The token
   * is persisted, and this effect exchanges it as soon as the app comes back
   * to the foreground, so "authorized" actually turns into an active session.
   */
  const wasAway = useRef(false);
  useEffect(() => {
    if (!pendingToken || connected) return;

    const markAway = () => {
      wasAway.current = true;
    };
    const tryFinish = () => {
      if (document.visibilityState === "hidden" || !wasAway.current) return;
      wasAway.current = false;
      void finishConnecting();
    };

    window.addEventListener("blur", markAway);
    window.addEventListener("focus", tryFinish);
    document.addEventListener("visibilitychange", tryFinish);

    // A token restored from storage means the app was killed or reloaded while
    // the user was authorizing; give the approval a moment, then exchange it.
    const staleMs = pendingTokenAt ? Date.now() - pendingTokenAt : 0;
    const timer =
      staleMs > 10_000 ? window.setTimeout(() => void finishConnecting(), 600) : null;

    return () => {
      window.removeEventListener("blur", markAway);
      window.removeEventListener("focus", tryFinish);
      document.removeEventListener("visibilitychange", tryFinish);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pendingToken, pendingTokenAt, connected, finishConnecting]);

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Connection status */}
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
              ? t("settings.lastfm.status.connected", { user: username || "Last.fm" }) ||
                `Connected as ${username || "Last.fm"}`
              : t("settings.lastfm.status.disconnected") || "Not connected to Last.fm"}
          </span>
        </div>
        <span className="text-[12px] text-text-tertiary font-mono">
          {enabled
            ? connected
              ? t("settings.lastfm.status.ready") || "Scrobbling"
              : t("settings.lastfm.status.waiting") || "Waiting for account"
            : t("settings.lastfm.status.disabled") || "Disabled"}
        </span>
      </div>

      {/* Master switch */}
      <SettingSection>
        <SettingRow
          title={t("settings.lastfm.enable.title") || "Enable Scrobbling"}
          description={
            t("settings.lastfm.enable.description") ||
            "Send now-playing updates and scrobbles to your Last.fm profile."
          }
          titleKey="settings.lastfm.enable.title"
          descKey="settings.lastfm.enable.description"
          searchQuery={searchQuery}
          control={<ToggleSwitch checked={enabled} onChange={setEnabled} />}
        />
      </SettingSection>

      {/* Account */}
      <SettingSection label={t("settings.lastfm.section_account") || "Account"}>
        <SettingRow
          title={t("settings.lastfm.account.title") || "Last.fm Account"}
          description={
            connected
              ? t("settings.lastfm.account.connected_description", { user: username || "" }) ||
                `Scrobbling as ${username || "Last.fm"}.`
              : t("settings.lastfm.account.description") ||
                "Authorize Liner to submit plays to your profile."
          }
          titleKey="settings.lastfm.account.title"
          descKey="settings.lastfm.account.description"
          searchQuery={searchQuery}
          control={
            connected ? (
              <Button variant="outline" size="sm" onClick={disconnect}>
                {t("settings.lastfm.disconnect") || "Disconnect"}
              </Button>
            ) : authUrl ? (
              <Button
                variant="primary"
                size="sm"
                disabled={busy !== null}
                onClick={finishConnecting}
              >
                {busy === "session"
                  ? t("settings.lastfm.connecting") || "Connecting…"
                  : t("settings.lastfm.connect_finish") || "I've authorized — connect"}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={busy !== null}
                onClick={openAuthorization}
              >
                {busy === "token"
                  ? t("settings.lastfm.connecting") || "Connecting…"
                  : t("settings.lastfm.connect") || "Connect to Last.fm"}
              </Button>
            )
          }
        />

        {/* Authorization link (shown after requesting a token) */}
        {!connected && authUrl && (
          <div className="px-[14px] py-[10px] rounded-lg bg-border-alpha-10 text-[13px] text-text-secondary leading-[1.5]">
            {t("settings.lastfm.authorize_hint") ||
              "Allow Liner on Last.fm in the opened page (or via the link below), then press Connect."}{" "}
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent-color)] underline break-all"
            >
              {t("settings.lastfm.authorize_link") || "Open the Last.fm authorization page"}
            </a>
          </div>
        )}

        {authError && (
          <div className="px-[14px] py-[8px] rounded-lg bg-red-500/10 text-[12px] text-red-400 break-words">
            {t("settings.lastfm.error_prefix") || "Error"}: {authError}
          </div>
        )}
      </SettingSection>
    </div>
  );
}
