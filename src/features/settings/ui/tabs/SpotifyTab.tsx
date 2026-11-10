import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/languages";
import { Button } from "@/shared/ui";
import type { ClientImportedPlaylist } from "@/features/library/services/import/importTypes";
import {
  connectSpotifyAccount,
  disconnectSpotifyAccount,
  importSpotifyAccountPlaylist,
  importSpotifyLikedSongs,
  isSpotifyAccountConnected,
  isSpotifyAccountAvailable,
  listSpotifyPlaylists,
  type SpotifyAccountPlaylist,
} from "@/features/library/services/import/sources/spotify/spotifyAccount";
import { useImportStore } from "@/features/library/store/importStore";
import { useModalStore } from "@/features/library/store/modalStore";
import { SettingBlock, SettingRow, SettingSection } from "../controls";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Spotify account import. The OAuth PKCE handshake runs in the Electron main
 * process (`electron/spotify-oauth.ts`) and the renderer only ever sees the
 * scoped access/refresh tokens, which stay in `sessionStorage`. Importing then
 * flows through the regular client import pipeline, so review, matching and
 * playlist creation behave exactly like a pasted link.
 */
export function SpotifyTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();

  const [connected, setConnected] = useState(isSpotifyAccountConnected);
  const [connecting, setConnecting] = useState(false);
  const [playlists, setPlaylists] = useState<SpotifyAccountPlaylist[]>([]);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPlaylists = useCallback(async () => {
    setLoadingPlaylists(true);
    setError(null);
    try {
      const list = await listSpotifyPlaylists();
      setPlaylists(list);
      setPlaylistsLoaded(true);
    } catch (err) {
      setError(errorMessage(err));
      if (!isSpotifyAccountConnected()) setConnected(false);
    } finally {
      setLoadingPlaylists(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    void loadPlaylists();
  }, [connected, loadPlaylists]);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await connectSpotifyAccount();
      setConnected(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    disconnectSpotifyAccount();
    setConnected(false);
    setPlaylists([]);
    setPlaylistsLoaded(false);
    setError(null);
  };

  const startImport = async (
    key: string,
    load: () => Promise<ClientImportedPlaylist>,
  ) => {
    setImportingKey(key);
    setError(null);
    try {
      const playlist = await load();
      await useImportStore.getState().startAccountImport(playlist);
      // The import keeps running in the background (toast + review dialog);
      // close settings so the user lands on their library, not the menu.
      useModalStore.getState().closeSettings();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImportingKey(null);
    }
  };

  const available = isSpotifyAccountAvailable();
  const busy = connecting || importingKey !== null;

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Connection status */}
      <div className="flex items-center justify-between px-[14px] py-[10px] rounded-lg bg-border-alpha-10">
        <div className="flex items-center gap-[10px]">
          <span
            className={`w-[8px] h-[8px] rounded-full shrink-0 ${
              connected
                ? "bg-[#1db954] shadow-[0_0_8px_rgba(29,185,84,0.5)]"
                : "bg-text-tertiary/40"
            }`}
          />
          <span className="text-[13px] text-text-primary font-medium">
            {connected
              ? t("settings.spotify.status.connected") || "Connected to Spotify"
              : t("settings.spotify.status.disconnected") || "Not connected to Spotify"}
          </span>
        </div>
        <span className="text-[12px] text-text-tertiary font-mono">
          {connected
            ? t("settings.spotify.status.ready") || "Ready to import"
            : t("settings.spotify.status.waiting") || "Waiting for account"}
        </span>
      </div>

      {!available && (
        <div className="px-[14px] py-[10px] rounded-lg bg-border-alpha-10 text-[13px] text-text-secondary leading-[1.5]">
          {t("settings.spotify.desktop_only") ||
            "Connecting a Spotify account is only available in the desktop app."}
        </div>
      )}

      {/* Account */}
      <SettingSection label={t("settings.spotify.section_account") || "Account"}>
        <SettingRow
          title={t("settings.spotify.account.title") || "Spotify Account"}
          description={
            connected
              ? t("settings.spotify.account.connected_description") ||
                "Pick a playlist or your liked songs to import below."
              : t("settings.spotify.account.description") ||
                "Authorize Neritium to read your playlists and liked songs. Nothing on Spotify is changed."
          }
          titleKey="settings.spotify.account.title"
          descKey="settings.spotify.account.description"
          searchQuery={searchQuery}
          control={
            connected ? (
              <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={busy}>
                {t("settings.spotify.disconnect") || "Disconnect"}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleConnect}
                disabled={!available || busy}
              >
                {connecting
                  ? t("settings.spotify.connecting") || "Waiting for Spotify…"
                  : t("settings.spotify.connect") || "Connect Spotify"}
              </Button>
            )
          }
        />
      </SettingSection>


      {/* Import */}
      {connected && (
        <>
          <SettingSection label={t("settings.spotify.section_import") || "Import"}>
            <SettingRow
              title={t("settings.spotify.liked.title") || "Liked Songs"}
              description={
                t("settings.spotify.liked.description") ||
                "Import every song you have liked on Spotify into Neritium."
              }
              titleKey="settings.spotify.liked.title"
              descKey="settings.spotify.liked.description"
              searchQuery={searchQuery}
              control={
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void startImport("liked", () => importSpotifyLikedSongs())
                  }
                >
                  {importingKey === "liked"
                    ? t("settings.spotify.playlists.importing") || "Importing…"
                    : t("settings.spotify.playlists.import") || "Import"}
                </Button>
              }
            />
          </SettingSection>

          <SettingSection>
            <SettingBlock
              title={t("settings.spotify.playlists.title") || "Your Playlists"}
              description={
                t("settings.spotify.playlists.description") ||
                "Import any playlist from your account, including private ones."
              }
              titleKey="settings.spotify.playlists.title"
              descKey="settings.spotify.playlists.description"
              searchQuery={searchQuery}
            >
              <div className="flex items-center justify-between gap-[12px]">
                <span className="text-[12px] text-text-tertiary">
                  {loadingPlaylists
                    ? t("settings.spotify.playlists.loading") || "Loading your playlists…"
                    : t("settings.spotify.playlists.count", {
                        count: playlists.length,
                      }) ||
                      `${playlists.length} playlists`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loadingPlaylists || busy}
                  onClick={() => void loadPlaylists()}
                >
                  {t("settings.spotify.playlists.refresh") || "Refresh"}
                </Button>
              </div>

              {playlistsLoaded && playlists.length === 0 ? (
                <p className="text-[12.5px] text-text-tertiary m-0">
                  {t("settings.spotify.playlists.empty") ||
                    "No playlists were found on this account."}
                </p>
              ) : (
                <div className="max-h-[280px] overflow-y-auto rounded-lg bg-border-alpha-10 divide-y divide-solid divide-border-primary">
                  {playlists.map((playlist) => (
                    <div
                      key={playlist.id}
                      className="flex items-center gap-[12px] px-[14px] py-[10px]"
                    >
                      <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
                        <span className="text-[13px] text-text-primary font-medium truncate">
                          {playlist.name}
                        </span>
                        <span className="text-[12px] text-text-tertiary truncate">
                          {t("settings.spotify.playlists.track_count", {
                            count: playlist.trackCount,
                          }) || `${playlist.trackCount} songs`}
                          {playlist.ownerName ? ` · ${playlist.ownerName}` : ""}
                        </span>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || playlist.trackCount === 0}
                        onClick={() =>
                          void startImport(playlist.id, () =>
                            importSpotifyAccountPlaylist(playlist.id, playlist.name),
                          )
                        }
                      >
                        {importingKey === playlist.id
                          ? t("settings.spotify.playlists.importing") || "Importing…"
                          : t("settings.spotify.playlists.import") || "Import"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </SettingBlock>
          </SettingSection>
        </>
      )}

      {error && (
        <div className="px-[14px] py-[8px] rounded-lg bg-red-500/10 text-[12px] text-red-400 break-words">
          {t("settings.spotify.error_prefix") || "Error"}: {error}
        </div>
      )}
    </div>
  );
}
