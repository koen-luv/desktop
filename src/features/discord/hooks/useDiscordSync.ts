import { useEffect, useRef, useState } from "react";
import { usePlayerState } from "@/features/player/hooks/usePlayerState";
import { useCoverSrc } from "@/features/covers";
import { api, mediaUrl, toMaxQualityAvatarUrl } from "@/shared/api";
import { getAuthSession } from "@/shared/api/auth-session";
import type { DiscordRpcStatePayload } from "../contracts";
import { useDiscordSettingsStore } from "../store/discordSettingsStore";

const artistAvatarCache = new Map<string, string | null>();
const pendingArtistAvatars = new Map<string, Promise<string | null>>();

function loadArtistAvatar(artistId: string): Promise<string | null> {
  const pending = pendingArtistAvatars.get(artistId);
  if (pending) return pending;
  const request = api
    .getArtistImage(artistId)
    .then((url) => (url ? toMaxQualityAvatarUrl(mediaUrl(url)) || null : null))
    .catch(() => null)
    .then((url) => {
      artistAvatarCache.set(artistId, url);
      pendingArtistAvatars.delete(artistId);
      return url;
    });
  pendingArtistAvatars.set(artistId, request);
  return request;
}

export function useDiscordSync() {
  const player = usePlayerState();
  const currentTrack = player.currentTrack;
  const effectiveCover = useCoverSrc(currentTrack?.coverUrl);
  const [loadedAvatar, setLoadedAvatar] = useState<{ artistId: string; url: string | null } | null>(null);

  const primaryArtistId =
    currentTrack?.artistId ||
    (Array.isArray(currentTrack?.artistList) && currentTrack.artistList.length > 0
      ? currentTrack.artistList[0]?.id
      : undefined);

  // Sync settings on mount
  useEffect(() => {
    const s = useDiscordSettingsStore.getState();
    window.linerElectron?.discordUpdateSettings?.({
      enabled: s.enabled,
      statusDisplayType: s.statusDisplayType,
      showArtwork: s.showArtwork,
      showArtistSmallImage: s.showArtistSmallImage,
      showTime: s.showTime,
      showPaused: s.showPaused,
      showButton: s.showButton,
      showDownloadButton: s.showDownloadButton,
    });
  }, []);

  // Clear Discord presence when logging out
  useEffect(() => {
    const handleAuthChange = () => {
      const session = getAuthSession();
      if (!session) {
        window.linerElectron?.discordUpdateState?.({
          status: "idle",
          track: null,
          positionMs: 0,
          durationMs: 0,
        });
      }
    };
    window.addEventListener("auth:changed", handleAuthChange);
    return () => {
      window.removeEventListener("auth:changed", handleAuthChange);
    };
  }, []);

  useEffect(() => {
    if (!primaryArtistId || primaryArtistId === "unknown" || artistAvatarCache.has(primaryArtistId)) return;
    let active = true;
    void loadArtistAvatar(primaryArtistId).then((url) => {
      if (active) setLoadedAvatar({ artistId: primaryArtistId, url });
    });
    return () => {
      active = false;
    };
  }, [primaryArtistId]);

  const artistAvatar =
    (primaryArtistId &&
      (loadedAvatar?.artistId === primaryArtistId ? loadedAvatar.url : artistAvatarCache.get(primaryArtistId))) ||
    undefined;

  // Track position prediction for seek detection
  const lastStateRef = useRef<{
    trackId: string | null;
    status: string;
    positionMs: number;
    timestamp: number;
    artistAvatar: string | undefined;
    coverUrl: string | undefined;
  }>({
    trackId: null,
    status: "idle",
    positionMs: 0,
    timestamp: Date.now(),
    artistAvatar: undefined,
    coverUrl: undefined,
  });

  // Push updates to Electron
  useEffect(() => {
    if (!window.linerElectron?.discordUpdateState) return;

    const trackId = currentTrack?.id ?? null;
    const coverUrl = effectiveCover || currentTrack?.coverUrl;
    const prev = lastStateRef.current;
    const now = Date.now();

    const trackChanged = prev.trackId !== trackId;
    const statusChanged = prev.status !== player.status;
    const avatarChanged = prev.artistAvatar !== artistAvatar;
    const coverChanged = prev.coverUrl !== coverUrl;

    // Detect manual seek (> 2500ms jump beyond normal elapsed time)
    let seeked = false;
    if (!trackChanged && !statusChanged && prev.status === "playing") {
      const elapsedSinceLastUpdate = now - prev.timestamp;
      const expectedPosition = prev.positionMs + elapsedSinceLastUpdate;
      if (Math.abs(player.positionMs - expectedPosition) > 2500) {
        seeked = true;
      }
    }

    // Only send IPC if there's a meaningful change (prevents rate-limiting Discord RPC)
    if (!trackChanged && !statusChanged && !avatarChanged && !coverChanged && !seeked) {
      return;
    }

    lastStateRef.current = {
      trackId,
      status: player.status,
      positionMs: player.positionMs,
      timestamp: now,
      artistAvatar,
      coverUrl,
    };

    const artistName =
      (currentTrack?.artists && typeof currentTrack.artists === "string" ? currentTrack.artists : "") ||
      ((currentTrack as any)?.artist && typeof (currentTrack as any).artist === "string" ? (currentTrack as any).artist : "") ||
      (Array.isArray(currentTrack?.artistList) && currentTrack.artistList.length > 0
        ? currentTrack.artistList
            .map((a: any) => (typeof a === "string" ? a : a?.name))
            .filter(Boolean)
            .join(", ")
        : "") ||
      "";

    const payload: DiscordRpcStatePayload = {
      status: player.status,
      track: currentTrack
        ? {
            id: currentTrack.id,
            title: currentTrack.title,
            artist: artistName,
            artistId: primaryArtistId,
            album:
              typeof currentTrack.album === "string"
                ? currentTrack.album
                : currentTrack.album?.title,
            coverUrl,
            durationMs: currentTrack.durationMs || player.durationMs,
          }
        : null,
      positionMs: player.positionMs,
      durationMs: player.durationMs || currentTrack?.durationMs || 0,
      artistImageUrl: artistAvatar,
    };

    window.linerElectron.discordUpdateState(payload);
  }, [
    player.status,
    player.positionMs,
    player.durationMs,
    currentTrack,
    effectiveCover,
    artistAvatar,
    primaryArtistId,
  ]);
}
