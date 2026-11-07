import { useNavigate, useSearchParams } from "react-router-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
  Suspense,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import PlaylistPageSkeleton from "./PlaylistPageSkeleton";
import {
  useToast,
  ReorderDropPlaceholder,
  FloatingDragCard,
} from "@/shared/ui";
import {
  AddLine,
  PlayFill,
  More2Line,
  HeartFill,
  PlaylistFill,
  PlaylistLine,
  MusicLine,
  CheckLine,
  ArrowLeftLine,
  ShareForwardLine,
} from "@mingcute/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  LuArrowUpDown,
  LuCheck,
  LuImageOff,
  LuImagePlus,
  LuPencil,
  LuTrash2,
  LuText,
  LuShuffle,
} from "react-icons/lu";
import { buildShareUrl } from "@/shared/utils/share";
import {
  isValidDiscordWebhookUrl,
  sendPlaylistWebhook,
  useDiscordWebhookStore,
} from "@/features/discord";
import discordLogo from "@/assets/branding/logo-discord.svg";
import Button from "@/shared/ui/Button";
import DropdownMenu from "@/shared/ui/DropdownMenu";
import SongCardWithMenu from "@/features/player/ui/SongCardWithMenu";
import CoverImage from "@/features/covers/ui/CoverImage";
import { useModalStore } from "../store/modalStore";
import {
  usePlaylist,
  useLikedTracks,
  useReorderPlaylistTracks,
  useSaveLikedSongsToPlaylist,
  useLikePlaylistTracks,
} from "../hooks";
import { useListReorder } from "@/shared/hooks";
import { playerEngine } from "@/features/player";
import type { Track } from "@/shared/types";
import { useTranslation } from "@/languages";
import { api } from "@/shared/api";
import { useIsContentTransparent } from "@/features/settings/store/customizationStore";
import {
  usePlaylistCoverOverride,
  usePlaylistSortKey,
  usePlaylistViewStore,
} from "../store/playlistViewStore";
import {
  PLAYLIST_SORT_KEYS,
  PLAYLIST_SORT_LABEL_KEYS,
  sortPlaylistTracks,
} from "../utils/playlistSort";
import { fileToPlaylistCover, PlaylistCoverError } from "../utils/playlistCoverImage";
import { isSharedPlaylistId } from "../services/sharedPlaylists";
import PlaylistCollaboratorsDialog from "./modals/PlaylistCollaboratorsDialog";
import {
  useTrackSearch,
  TrackSearchField,
  TrackSearchEmpty,
} from "./TrackSearch";

const TRACK_ROW_HEIGHT = 64;

interface PlaylistCoverProps {
  urls: string[];
  title: string;
  isLikesMode: boolean;
  hasCustomBg: boolean;
}

function PlaylistCover({
  urls,
  title,
  isLikesMode,
  hasCustomBg,
}: PlaylistCoverProps) {
  if (urls.length === 0) {
    if (isLikesMode) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-rose-500/85 via-pink-500/70 to-violet-600/85">
          <HeartFill size={44} className="text-white drop-shadow-sm" />
        </div>
      );
    }
    return (
      <PlaylistFill
        size={44}
        className={hasCustomBg ? "text-white" : "text-border-alpha-33"}
      />
    );
  }

  if (urls.length === 1) {
    return (
      <CoverImage
        src={urls[0]}
        alt={title}
        fill
        sizes="168px"
        className="object-cover"
        draggable={false}
        unoptimized
      />
    );
  }

  const cells = urls.slice(0, 4);
  return (
    <div className="absolute inset-0 grid grid-cols-2 gap-[1.5px] bg-border-alpha-8">
      {cells.map((url, index) => {
        const spanFull = cells.length === 3 && index === 0;
        return (
          <div
            key={index}
            className={`relative overflow-hidden${spanFull ? " row-span-2" : ""}`}
          >
            <CoverImage
              src={url}
              alt={`${title} cover ${index + 1}`}
              fill
              sizes="84px"
              className="object-cover"
              draggable={false}
              unoptimized
            />
          </div>
        );
      })}
    </div>
  );
}

interface PlaylistBackdropProps {
  coverUrl: string;
  isLikesMode: boolean;
  hasCustomBg: boolean;
  visible: boolean;
}

function PlaylistBackdrop({
  coverUrl,
  isLikesMode,
  hasCustomBg,
  visible,
}: PlaylistBackdropProps) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          draggable={false}
          className="absolute left-1/2 top-[-12%] h-[125%] w-[120%] -translate-x-1/2 scale-110 object-cover blur-[90px] saturate-150"
        />
      ) : (
        <div
          className={`absolute inset-0 ${
            isLikesMode
              ? "bg-gradient-to-br from-rose-500/35 via-violet-500/20 to-transparent"
              : "bg-gradient-to-br from-bg-panel via-bg-surface to-bg-surface"
          }`}
        />
      )}
      <div
        className={`absolute inset-0 ${
          hasCustomBg
            ? "bg-bg-surface/25 dark:bg-black/20"
            : "bg-bg-surface/55 dark:bg-black/35"
        }`}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-bg-surface/10 to-bg-surface/95" />
    </div>
  );
}

interface TrackItemProps {
  track: Track;
  trackNumber: number;
  playlistId?: string;
  playlistTitle: string;
  playlistCoverUrl: string;
  allTracks: Track[];
  style?: React.CSSProperties;
  showReorderHandle?: boolean;
  onGrabStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  highlight?: string;
}

const TrackItem = memo(function TrackItem({
  track,
  trackNumber,
  playlistId,
  playlistTitle,
  playlistCoverUrl,
  allTracks,
  style,
  showReorderHandle,
  onGrabStart,
  highlight,
}: TrackItemProps) {
  const handlePlay = useCallback(() => {
    if (typeof window !== "undefined" && window.__linerWasDragging) return;
    const context = playlistId ? `playlist:${playlistId}` : playlistTitle;
    playerEngine.playTrack(
      track,
      allTracks,
      context,
      playlistCoverUrl,
    );
  }, [track, allTracks, playlistId, playlistTitle, playlistCoverUrl]);

  return (
    <div style={style} data-reorder-item>
      <SongCardWithMenu
        id={track.id}
        title={track.title}
        artists={track.artists}
        artistId={track.artistId}
        artistList={track.artistList}
        coverUrl={track.coverUrl || playlistCoverUrl}
        trackNumber={trackNumber}
        playlistId={playlistId}
        playlistItemId={track.playlistItemId}
        playlistTitle={playlistTitle}
        showReorderHandle={showReorderHandle}
        onGrabStart={onGrabStart}
        highlight={highlight}
        duration={
          track.durationMs
            ? `${Math.floor(track.durationMs / 60000)}:${String(
                Math.floor((track.durationMs % 60000) / 1000),
              ).padStart(2, "0")}`
            : undefined
        }
        durationMs={track.durationMs}
        explicit={track.explicit}
        onPlay={handlePlay}
      />
    </div>
  );
});

function LibraryPlaylistContent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const id = searchParams.get("id");
  const isLikesMode = id === "likes";
  const decodedId = id ? decodeURIComponent(id) : null;
  const isSharedPlaylist = Boolean(decodedId && isSharedPlaylistId(decodedId));
  const scrollRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const hasCustomBg = useIsContentTransparent();

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false);
  const reorderTracks = useReorderPlaylistTracks();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const descriptionRef = useRef<HTMLParagraphElement>(null);

  const {
    data: playlistDetail,
    isLoading: playlistLoading,
  } = usePlaylist(isLikesMode ? null : decodedId);

  const { data: likesData, isLoading: likesLoading } = useLikedTracks(
    isLikesMode ? { limit: 1000, offset: 0 } : undefined,
  );

  const isLoading = isLikesMode ? likesLoading : playlistLoading;

  // Presentation prefs are per device: a custom cover (the API has no cover
  // field) and the chosen sort order, both remembered per playlist.
  const playlistKey = isLikesMode ? "likes" : decodedId;
  const customCover = usePlaylistCoverOverride(isLikesMode ? null : decodedId);
  const sortKey = usePlaylistSortKey(playlistKey);
  const setSortKey = usePlaylistViewStore((s) => s.setSort);
  const setCustomCover = usePlaylistViewStore((s) => s.setCover);
  const clearCustomCover = usePlaylistViewStore((s) => s.clearCover);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const viewData = (() => {
    if (isLikesMode) {
      if (!likesData) return null;
      const tracks: Track[] = (likesData.tracks ?? []).map((track) => ({
        ...track,
        playCount: 0,
      }));
      return {
        title: t("playlist.liked_songs"),
        bio: "",
        countLabel: t("common.tracks", { count: tracks.length }),
        coverUrl: "",
        coverUrls: [] as string[],
        tracks,
        revision: 0,
        isShared: false,
        sharedRole: undefined,
      };
    }
    if (!playlistDetail) return null;
    const bio = playlistDetail.description?.trim() ?? "";
    const generatedUrls =
      playlistDetail.coverUrls ??
      (playlistDetail.coverUrl ? [playlistDetail.coverUrl] : []);
    return {
      title: playlistDetail.title || t("playlist.untitled_playlist"),
      bio,
      countLabel: t("common.tracks", { count: playlistDetail.trackCount }),
      coverUrl: customCover || playlistDetail.coverUrl || "",
      coverUrls: customCover ? [customCover] : generatedUrls,
      tracks: playlistDetail.tracks,
      revision: playlistDetail.revision,
      isShared: playlistDetail.isShared,
      sharedRole: playlistDetail.sharedRole,
    };
  })();

  useEffect(() => {
    if (isEditingTitle && titleRef.current) {
      titleRef.current.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(titleRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [isEditingTitle]);

  useEffect(() => {
    if (isEditingDescription && descriptionRef.current) {
      descriptionRef.current.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(descriptionRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [isEditingDescription]);

  const trackListContainerRef = useRef<HTMLDivElement>(null);
  const [optimisticTracks, setOptimisticTracks] = useState<Track[] | null>(null);

  useEffect(() => {
    setOptimisticTracks(null);
  }, [viewData?.revision, decodedId]);

  const currentTracks = useMemo(() => {
    return optimisticTracks ?? viewData?.tracks ?? [];
  }, [optimisticTracks, viewData?.tracks]);

  // What the page shows (and plays) in the chosen order. `custom` keeps the
  // server order so drag-reordering stays meaningful.
  const sortedTracks = useMemo(
    () => sortPlaylistTracks(currentTracks, sortKey),
    [currentTracks, sortKey],
  );

  const search = useTrackSearch(sortedTracks, id);
  const isFiltering = search.matches !== null;
  const visibleTracks = useMemo(
    () => search.matches ?? sortedTracks.map((track, index) => ({ track, index })),
    [search.matches, sortedTracks],
  );

  // results start at the top, not wherever the full list was scrolled to
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [search.activeQuery]);

  useEffect(() => {
    if (search.isOpen) {
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [search.isOpen]);

  const handleSearchSubmit = useCallback(() => {
    const first = search.matches?.[0];
    if (!first || !viewData) return;
    const context = decodedId ? `playlist:${decodedId}` : viewData.title;
    playerEngine.playTrack(first.track, sortedTracks, context, viewData.coverUrl);
  }, [search.matches, viewData, decodedId, sortedTracks]);

  const handlePlayAll = useCallback(() => {
    if (!sortedTracks.length || !viewData) return;
    const context = decodedId ? `playlist:${decodedId}` : viewData.title;
    playerEngine.clearQueue();
    playerEngine.playTrack(
      sortedTracks[0],
      sortedTracks,
      context,
      viewData.coverUrl,
    );
  }, [sortedTracks, viewData, decodedId]);

  const handleShufflePlay = useCallback(() => {
    if (!sortedTracks.length || !viewData) return;
    const context = decodedId ? `playlist:${decodedId}` : viewData.title;
    playerEngine.clearQueue();
    void playerEngine.playShuffled(
      sortedTracks,
      context,
      viewData.coverUrl,
    );
  }, [sortedTracks, viewData, decodedId]);

  const { toast } = useToast();
  const [addedToQueue, setAddedToQueue] = useState(false);

  const handleAddToQueue = useCallback(() => {
    if (!sortedTracks.length || !viewData) return;
    for (const track of sortedTracks) {
      playerEngine.addToQueue(track);
    }
    const playlistTitle = viewData.title || t("playlist.untitled_playlist");
    toast(t("playlist.added_to_queue"), "info", {
      description: playlistTitle,
    });
    setAddedToQueue(true);
    const timer = setTimeout(() => {
      setAddedToQueue(false);
    }, 1200);
    return () => clearTimeout(timer);
  }, [sortedTracks, viewData, toast, t]);

  const saveLikesAsPlaylist = useSaveLikedSongsToPlaylist();
  const likePlaylistTracks = useLikePlaylistTracks();

  const handleSaveLikesAsPlaylist = useCallback(async () => {
    if (saveLikesAsPlaylist.isPending || sortedTracks.length === 0) return;
    try {
      const result = await saveLikesAsPlaylist.mutateAsync({
        trackIds: sortedTracks.map((track) => track.id),
        title: t("playlist.liked_songs"),
      });
      toast(t("playlist.saved_as_playlist"), "checkmark", {
        description: result.playlist.title,
      });
      navigate(`/library/playlist?id=${encodeURIComponent(result.playlist.id)}`);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t("playlist.save_as_playlist_failed"),
        "error",
      );
    }
  }, [navigate, saveLikesAsPlaylist, sortedTracks, t, toast]);

  const handleLikeAll = useCallback(async () => {
    if (likePlaylistTracks.isPending || sortedTracks.length === 0) return;
    const trackIds = sortedTracks.map((track) => track.id);
    try {
      const { liked, failed } = await likePlaylistTracks.mutateAsync({ trackIds });
      if (failed > 0) {
        toast(t("playlist.like_all_partial", { count: liked, failed }), "info", {
          description: viewData?.title || undefined,
        });
      } else {
        toast(t("playlist.like_all_done", { count: liked }), "checkmark", {
          description: viewData?.title || undefined,
        });
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t("playlist.like_all_failed"),
        "error",
      );
    }
  }, [likePlaylistTracks, sortedTracks, t, toast, viewData?.title]);

  const handleCoverFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || !decodedId || isLikesMode) return;
      try {
        const dataUrl = await fileToPlaylistCover(file);
        setCustomCover(decodedId, dataUrl);
        toast(t("playlist.cover_updated"), "checkmark");
      } catch (error) {
        const code = error instanceof PlaylistCoverError ? error.code : "decode_failed";
        toast(
          code === "too_large" ? t("playlist.cover_too_large") : t("playlist.cover_invalid"),
          "error",
        );
      }
    },
    [decodedId, isLikesMode, setCustomCover, t, toast],
  );

  const handleShare = useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.clipboard && decodedId) {
      navigator.clipboard.writeText(buildShareUrl("playlist", decodedId));
      if (!isSharedPlaylist) {
        void api.updatePlaylist(decodedId, { isPublic: true }).catch(() => {});
      }
      toast(t("common.link_copied"), "checkmark", {
        description: viewData?.title || undefined,
      });
    }
  }, [decodedId, isSharedPlaylist, viewData?.title, toast, t]);

  const webhookEnabled = useDiscordWebhookStore((state) => state.enabled);
  const webhookUrl = useDiscordWebhookStore((state) => state.url);
  const canSendToDiscord = webhookEnabled && isValidDiscordWebhookUrl(webhookUrl);

  const handleSendToDiscord = useCallback(() => {
    if (!viewData || !canSendToDiscord) return;
    void sendPlaylistWebhook(webhookUrl, {
      id: isLikesMode ? undefined : (decodedId ?? undefined),
      title: viewData.title,
      trackCount: currentTracks.length,
      coverUrl: viewData.coverUrl,
    })
      .then(() => toast(t("playlist.sent_to_discord"), "checkmark"))
      .catch(() => toast(t("playlist.send_to_discord_failed"), "error"));
  }, [
    canSendToDiscord,
    currentTracks.length,
    decodedId,
    isLikesMode,
    t,
    toast,
    viewData,
    webhookUrl,
  ]);

  const handleReorderCommit = useCallback(
    (fromIndex: number, toIndex: number, movingTrack: Track) => {
      if (!decodedId || !viewData || isLikesMode) return;
      if (fromIndex === toIndex || !movingTrack.playlistItemId) return;

      const nextList = [...currentTracks];
      const [item] = nextList.splice(fromIndex, 1);
      nextList.splice(toIndex, 0, item);

      const nextItem = nextList[toIndex + 1];
      const beforeItemId = nextItem ? (nextItem.playlistItemId ?? null) : null;

      setOptimisticTracks(nextList);

      reorderTracks.mutate({
        playlistId: decodedId,
        itemId: movingTrack.playlistItemId,
        beforeItemId,
        revision: viewData.revision,
      });
    },
    [currentTracks, decodedId, isLikesMode, reorderTracks, viewData],
  );

  const {
    isDragging,
    dragIndex,
    dropIndex,
    draggedItem,
    pointerPos,
    grabOffset,
    itemWidth,
    handleCardGrab,
  } = useListReorder<Track>({
    items: sortedTracks,
    scrollContainerRef: scrollRef,
    listContainerRef: trackListContainerRef,
    itemHeight: TRACK_ROW_HEIGHT,
    onReorder: handleReorderCommit,
    edgeThreshold: 80,
    maxScrollSpeed: 22,
  });

  // The page itself scrolls, so the virtualiser's first row starts below the
  // hero and the rounded track sheet.
  const [listScrollMargin, setListScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = trackListContainerRef.current;
    if (!scroller || !list) {
      setListScrollMargin(0);
      return;
    }
    const measure = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const next = listRect.top - scrollerRect.top + scroller.scrollTop;
      setListScrollMargin((previous) =>
        Math.abs(previous - next) < 0.5 ? previous : next,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(list);
    if (heroRef.current) observer?.observe(heroRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [
    search.activeQuery,
    visibleTracks.length,
    viewData?.title,
    viewData?.bio,
  ]);

  const rowVirtualizer = useVirtualizer({
    count: visibleTracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TRACK_ROW_HEIGHT,
    overscan: 25,
    scrollMargin: listScrollMargin,
    getItemKey: (index) =>
      visibleTracks[index]?.track.playlistItemId ??
      visibleTracks[index]?.track.id ??
      index,
  });

  const handleBack = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/library");
    }
  }, [navigate]);

  const targetScrollTopRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const handleTopWheel = useCallback((e: React.WheelEvent) => {
    const container = scrollRef.current;
    if (!container) return;

    const maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll <= 0) return;

    const current = targetScrollTopRef.current ?? container.scrollTop;
    const target = Math.max(0, Math.min(maxScroll, current + e.deltaY));
    targetScrollTopRef.current = target;

    if (rafIdRef.current === null) {
      const step = () => {
        if (!scrollRef.current || targetScrollTopRef.current === null) {
          rafIdRef.current = null;
          return;
        }
        const now = scrollRef.current.scrollTop;
        const diff = targetScrollTopRef.current - now;
        if (Math.abs(diff) < 0.5) {
          scrollRef.current.scrollTop = targetScrollTopRef.current;
          targetScrollTopRef.current = null;
          rafIdRef.current = null;
          return;
        }
        scrollRef.current.scrollTop = now + diff * 0.25;
        rafIdRef.current = requestAnimationFrame(step);
      };
      rafIdRef.current = requestAnimationFrame(step);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  const urlsToPreload = useMemo(() => {
    if (!viewData) return [];
    const urls = new Set<string>();
    if (viewData.coverUrl) urls.add(viewData.coverUrl);
    if (viewData.coverUrls) {
      for (const url of viewData.coverUrls) {
        if (url) urls.add(url);
      }
    }
    return Array.from(urls);
  }, [viewData]);

  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [skeletonExited, setSkeletonExited] = useState(false);

  useEffect(() => {
    if (isLoading || !viewData) {
      setImagesLoaded(false);
      setSkeletonExited(false);
      return;
    }
    if (urlsToPreload.length === 0) {
      setImagesLoaded(true);
      return;
    }
    let active = true;
    let settled = false;
    const timer = setTimeout(() => {
      if (active && !settled) {
        settled = true;
        setImagesLoaded(true);
      }
    }, 150);

    const promises = urlsToPreload.map(
      (url) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.src = url;
          if (image.complete) {
            resolve();
            return;
          }
          image.onload = () => resolve();
          image.onerror = () => resolve();
        }),
    );

    Promise.all(promises).then(() => {
      if (active && !settled) {
        settled = true;
        clearTimeout(timer);
        setImagesLoaded(true);
      }
    });

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [isLoading, viewData, urlsToPreload]);

  const isReady = !isLoading && !!viewData && imagesLoaded;

  useEffect(() => {
    if (isReady && !skeletonExited) {
      const timer = setTimeout(() => {
        setSkeletonExited(true);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [isReady, skeletonExited]);

  const totalDurationLabel = useMemo(() => {
    const totalMs = (viewData?.tracks ?? []).reduce(
      (total, track) => total + (track.durationMs || 0),
      0,
    );
    const totalMins = Math.floor(totalMs / 60000);
    if (totalMins > 60) {
      return `${Math.floor(totalMins / 60)} ${t("playlist.hr")} ${totalMins % 60} ${t("playlist.min")}`;
    }
    const totalSecs = Math.floor((totalMs % 60000) / 1000);
    return `${totalMins} ${t("playlist.min")} ${totalSecs} ${t("playlist.sec")}`;
  }, [viewData?.tracks, t]);

  const coverUrls = viewData?.coverUrls ?? (viewData?.coverUrl ? [viewData.coverUrl] : []);
  const backdropUrl = viewData?.coverUrl || coverUrls.find(Boolean) || "";
  const chipClass = hasCustomBg
    ? "apple-glass-pill"
    : "bg-black/[0.045] text-text-primary dark:bg-white/[0.08]";

  if (!isLoading && !viewData) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-transparent">
        <span className="text-text-secondary">
          {isLikesMode
            ? t("playlist.likes_empty")
            : t("playlist.not_found")}
        </span>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-transparent">
      {viewData && (
        <PlaylistBackdrop
          coverUrl={backdropUrl}
          isLikesMode={isLikesMode}
          hasCustomBg={hasCustomBg}
          visible={isReady}
        />
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 hidden h-[56px] select-none md:block">
        <div
          data-window-drag
          onContextMenu={(event) => event.preventDefault()}
          onWheel={handleTopWheel}
          className="pointer-events-auto h-full w-full"
        />
      </div>

      <button
        type="button"
        onClick={handleBack}
        aria-label={t("common.back")}
        data-no-tooltip="true"
        data-no-window-drag
        className={`absolute left-4 top-[calc(var(--inset-top,0px)+12px)] z-20 group inline-flex h-[32px] shrink-0 items-center gap-[6px] rounded-full px-[12px] text-[13px] font-[500] transition-all duration-150 active:scale-[0.94] cursor-pointer select-none border-0 !border-none focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent-soft md:left-[32px] md:top-[12px] ${
          hasCustomBg
            ? "apple-glass-pill !border-none"
            : "bg-bg-panel/85 text-text-primary backdrop-blur-xl hover:bg-bg-panel border-0 !border-none"
        }`}
        style={{ fontFamily: "var(--font-inter), sans-serif" }}
      >
        <ArrowLeftLine
          size={16}
          className="transition-transform duration-150 group-hover:-translate-x-0.5"
        />
        <span className="relative -left-[1.5px] top-[1px]">{t("common.back")}</span>
      </button>

      <div
        ref={scrollRef}
        onScroll={() => {
          if (rafIdRef.current === null) {
            targetScrollTopRef.current = null;
          }
        }}
        className="relative z-1 h-full w-full overflow-y-auto overflow-x-hidden overscroll-contain"
        style={{ willChange: "scroll-position" }}
      >
        <div className="min-h-full w-full px-4 pb-[calc(var(--inset-bottom,0px)+96px)] pt-[calc(var(--inset-top,0px)+64px)] md:px-[32px] md:pt-[76px]">
          {viewData && (
            <div
              className={`transition-opacity duration-200 ease-out ${
                isReady ? "opacity-100" : "pointer-events-none opacity-0"
              }`}
            >
              <div ref={heroRef} data-no-window-drag>
                <div className="flex items-start gap-4 md:gap-[22px]">
                  <div
                    className={`relative flex h-[112px] w-[112px] shrink-0 items-center justify-center overflow-hidden rounded-[14px] shadow-e2 ring-1 ring-border-primary/40 sm:h-[144px] sm:w-[144px] md:h-[168px] md:w-[168px] md:rounded-[12px] ${
                      hasCustomBg && coverUrls.length === 0
                        ? "apple-glass-static pointer-events-none"
                        : "bg-bg-panel"
                    }`}
                  >
                    <PlaylistCover
                      urls={coverUrls}
                      title={viewData.title}
                      isLikesMode={isLikesMode}
                      hasCustomBg={hasCustomBg}
                    />
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col pt-0.5 md:min-h-[168px]">
                    <div className="min-h-[112px] sm:min-h-[144px] md:min-h-0">
                    <h1
                      ref={titleRef}
                      className={`m-0 line-clamp-2 text-[28px] font-[650] leading-[1.06] tracking-[-0.045em] text-text-primary sm:text-[32px] lg:text-[36px] ${
                        isLikesMode
                          ? ""
                          : "cursor-text outline-none transition-colors"
                      } ${
                        isEditingTitle
                          ? "-ml-[4px] rounded-[4px] bg-border-alpha-14 px-[4px]"
                          : ""
                      }`}
                      style={{ fontFamily: "var(--font-inter), sans-serif" }}
                      contentEditable={
                        isLikesMode || isSharedPlaylist ? false : isEditingTitle
                      }
                      suppressContentEditableWarning
                      onBlur={(event) => {
                        if (!isEditingTitle) return;
                        const title = event.currentTarget.textContent?.trim();
                        if (title && decodedId && title !== viewData.title) {
                          void api
                            .updatePlaylist(decodedId, { title })
                            .then(() =>
                              window.dispatchEvent(new Event("library:changed")),
                            );
                        }
                        setIsEditingTitle(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          event.currentTarget.textContent = viewData.title;
                          event.currentTarget.blur();
                          setIsEditingTitle(false);
                        }
                      }}
                      onClick={() => {
                        if (!isLikesMode && !isSharedPlaylist) {
                          setIsEditingTitle(true);
                        }
                      }}
                    >
                      {viewData.title}
                    </h1>

                    {!isLikesMode &&
                      (viewData.bio || isEditingDescription ? (
                        <p
                          ref={descriptionRef}
                          className={`m-0 mt-[6px] line-clamp-2 max-w-[720px] cursor-text text-[13px] leading-[1.5] text-text-secondary outline-none transition-colors empty:min-h-[20px] sm:text-[13.5px] ${
                            isEditingDescription
                              ? "-ml-[4px] rounded-[4px] bg-border-alpha-14 px-[4px]"
                              : ""
                          }`}
                          style={{ fontFamily: "var(--font-inter), sans-serif" }}
                          contentEditable={!isSharedPlaylist && isEditingDescription}
                          suppressContentEditableWarning
                          onBlur={(event) => {
                            if (!isEditingDescription) return;
                            const next = event.currentTarget.textContent?.trim() ?? "";
                            if (decodedId && next !== viewData.bio) {
                              void api
                                .updatePlaylist(decodedId, { description: next })
                                .then(() =>
                                  window.dispatchEvent(new Event("library:changed")),
                                );
                            }
                            setIsEditingDescription(false);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                            if (event.key === "Escape") {
                              event.currentTarget.textContent = viewData.bio;
                              event.currentTarget.blur();
                              setIsEditingDescription(false);
                            }
                          }}
                          onClick={() => {
                            if (!isSharedPlaylist) setIsEditingDescription(true);
                          }}
                        >
                          {viewData.bio}
                        </p>
                      ) : !isSharedPlaylist ? (
                        <button
                          type="button"
                          onClick={() => setIsEditingDescription(true)}
                          className="mt-[6px] w-fit cursor-pointer border-0 bg-transparent p-0 text-left text-[13px] font-[400] text-text-tertiary transition-colors hover:text-text-primary"
                          style={{ fontFamily: "var(--font-inter), sans-serif" }}
                        >
                          {t("common.add_description")}
                        </button>
                      ) : null)}

                    <div className="mt-[12px] flex flex-wrap items-center gap-[6px]">
                      <div
                        className={`inline-flex h-[26px] items-center gap-[6px] rounded-[9px] px-[10px] text-[12px] font-[400] select-none ${chipClass}`}
                      >
                        <MusicLine
                          size={13}
                          className={
                            hasCustomBg
                              ? "shrink-0 text-white"
                              : "shrink-0 text-text-secondary"
                          }
                        />
                        <span>{viewData.countLabel}</span>
                        <span
                          className={`h-[3px] w-[3px] shrink-0 rounded-full ${
                            hasCustomBg ? "bg-white/50" : "bg-text-tertiary/50"
                          }`}
                          aria-hidden="true"
                        />
                        <span>{totalDurationLabel}</span>
                      </div>
                    </div>
                    </div>

                    <div className="-ml-[128px] mt-4 flex w-[calc(100%+128px)] flex-wrap items-center gap-2 sm:-ml-[160px] sm:w-[calc(100%+160px)] md:ml-0 md:mt-auto md:w-full md:pt-4">
                      <Button
                        variant={hasCustomBg ? "glass-primary" : "primary"}
                        onClick={handlePlayAll}
                        disabled={currentTracks.length === 0}
                        className="!h-[38px] min-w-[120px] flex-1 gap-[6px] px-[18px] !text-[13.5px] !font-[500] sm:flex-none"
                      >
                        <PlayFill size={16} />
                        <span>{t("common.play_all")}</span>
                      </Button>

                      <Button
                        variant={hasCustomBg ? "glass-action" : "outline"}
                        onClick={handleShufflePlay}
                        disabled={currentTracks.length === 0}
                        className="!h-[38px] !w-[38px] shrink-0 !p-0 text-text-primary"
                        title={t("common.shuffle")}
                      >
                        <LuShuffle size={17} />
                      </Button>

                      <div className="order-last w-full md:order-none md:ml-auto md:w-[220px] xl:w-[280px]">
                        <TrackSearchField
                          search={search}
                          totalCount={currentTracks.length}
                          placeholder={t("track_search.placeholder_playlist")}
                          glass={hasCustomBg}
                          onSubmit={handleSearchSubmit}
                          persistent
                          className="!w-full"
                        />
                      </div>

                      <Button
                        variant={hasCustomBg ? "glass-action" : "outline"}
                        onClick={handleAddToQueue}
                        disabled={currentTracks.length === 0}
                        className="!h-[38px] !w-[38px] shrink-0 !p-0 !text-[13px] !font-[500] sm:!w-auto sm:gap-[6px] sm:px-[14px]"
                        title={t("common.add_to_queue")}
                      >
                        <AnimatePresence mode="wait">
                          {addedToQueue ? (
                            <motion.span
                              key="check"
                              initial={{ opacity: 0, scale: 0.5 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.5 }}
                              transition={{ duration: 0.08 }}
                              className="flex shrink-0 items-center justify-center text-emerald-400"
                            >
                              <CheckLine size={16} />
                            </motion.span>
                          ) : (
                            <motion.span
                              key="add"
                              initial={{ opacity: 0, scale: 0.5 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.5 }}
                              transition={{ duration: 0.08 }}
                              className="flex shrink-0 items-center justify-center"
                            >
                              <AddLine size={16} />
                            </motion.span>
                          )}
                        </AnimatePresence>
                        <span className="hidden truncate sm:inline">
                          {t("common.add_to_queue")}
                        </span>
                      </Button>

                      <DropdownMenu
                        trigger={
                          <Button
                            variant={hasCustomBg ? "glass-action" : "outline"}
                            className="!h-[38px] !w-[38px] shrink-0 !p-0 text-text-primary"
                            title={t(PLAYLIST_SORT_LABEL_KEYS[sortKey])}
                          >
                            <LuArrowUpDown size={16} />
                          </Button>
                        }
                        items={PLAYLIST_SORT_KEYS.map((key) => ({
                          id: `sort-${key}`,
                          icon: sortKey === key ? <LuCheck size={15} /> : undefined,
                          label: t(PLAYLIST_SORT_LABEL_KEYS[key]),
                          onClick: () => {
                            if (playlistKey) setSortKey(playlistKey, key);
                          },
                        }))}
                      />

                      {isLikesMode && (
                        <DropdownMenu
                          trigger={
                            <Button
                              variant={hasCustomBg ? "glass-action" : "outline"}
                              className="!h-[38px] !w-[38px] shrink-0 !p-0 text-text-primary"
                              title={t("common.more")}
                              disabled={
                                currentTracks.length === 0 ||
                                saveLikesAsPlaylist.isPending
                              }
                            >
                              {saveLikesAsPlaylist.isPending ? (
                                <span className="h-[14px] w-[14px] animate-spin rounded-full border-2 border-text-tertiary border-t-transparent" />
                              ) : (
                                <More2Line size={18} />
                              )}
                            </Button>
                          }
                          items={[
                            {
                              id: "save-likes-as-playlist",
                              icon: <PlaylistLine size={15} />,
                              label: t("playlist.save_as_playlist"),
                              onClick: () => void handleSaveLikesAsPlaylist(),
                            },
                          ]}
                        />
                      )}

                      {!isLikesMode && (
                        <DropdownMenu
                          trigger={
                            <Button
                              variant={hasCustomBg ? "glass-action" : "outline"}
                              className="!h-[38px] !w-[38px] shrink-0 !p-0 text-text-primary"
                              title={t("common.more")}
                            >
                              <More2Line size={18} />
                            </Button>
                          }
                          items={[
                            {
                              id: "like-all",
                              icon: <HeartFill size={15} />,
                              label: t("playlist.like_all_songs"),
                              onClick: () => void handleLikeAll(),
                            },
                            {
                              id: "collaborators",
                              icon: <PlaylistLine size={15} />,
                              label: t("playlist.collaborators_manage"),
                              onClick: () => setCollaboratorsOpen(true),
                            },
                            {
                              id: "rename",
                              icon: <LuPencil size={15} />,
                              label: t("common.rename"),
                              disabled: isSharedPlaylist,
                              onClick: () => setIsEditingTitle(true),
                            },
                            {
                              id: "edit-description",
                              icon: <LuText size={15} />,
                              label: t("common.edit_description"),
                              disabled: isSharedPlaylist,
                              onClick: () => setIsEditingDescription(true),
                            },
                            ...(!isSharedPlaylist
                              ? [
                                  {
                                    id: "share",
                                    icon: <ShareForwardLine size={15} />,
                                    label: t("common.share"),
                                    onClick: handleShare,
                                  },
                                ]
                              : []),
                            ...(canSendToDiscord
                              ? [
                                  {
                                    id: "send-discord",
                                    icon: (
                                      <img
                                        src={discordLogo}
                                        alt=""
                                        className="h-[15px] w-[15px]"
                                        draggable={false}
                                      />
                                    ),
                                    label: t("playlist.send_to_discord"),
                                    onClick: handleSendToDiscord,
                                  },
                                ]
                              : []),
                            {
                              id: "change-cover",
                              icon: <LuImagePlus size={15} />,
                              label: t("playlist.cover_change"),
                              onClick: () => coverInputRef.current?.click(),
                            },
                            ...(customCover
                              ? [
                                  {
                                    id: "remove-cover",
                                    icon: <LuImageOff size={15} />,
                                    label: t("playlist.cover_remove"),
                                    onClick: () => {
                                      if (!decodedId) return;
                                      clearCustomCover(decodedId);
                                      toast(t("playlist.cover_removed"), "info");
                                    },
                                  },
                                ]
                              : []),
                            {
                              id: "delete",
                              icon: <LuTrash2 size={15} />,
                              label: t("common.delete"),
                              danger: true,
                              onClick: () => {
                                if (!decodedId) return;
                                useModalStore.getState().openRemoveFromLibrary({
                                  id: decodedId,
                                  title: viewData.title,
                                  coverUrl: viewData.coverUrl,
                                  type: "playlist",
                                  isOwned:
                                    !viewData.isShared ||
                                    viewData.sharedRole === "owner",
                                });
                              },
                            },
                          ]}
                        />
                      )}

                      <input
                        ref={coverInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleCoverFile}
                        data-no-window-drag
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div
                data-no-window-drag
                className="mt-5 overflow-hidden rounded-[16px] bg-black/[0.035] p-[6px] shadow-[inset_0_0_0_1px_var(--border-primary)] backdrop-blur-2xl dark:bg-white/[0.05] md:mt-6 md:p-2"
              >
                {currentTracks.length === 0 ? (
                  <div className="flex min-h-[46vh] flex-col items-center justify-center gap-[12px] text-center">
                    <PlaylistFill size={40} className="text-border-alpha-33" />
                    <div className="flex flex-col gap-[4px]">
                      <p
                        className="m-0 text-[15px] font-[500] text-text-primary"
                        style={{ fontFamily: "var(--font-inter), sans-serif" }}
                      >
                        {t("playlist.empty_title")}
                      </p>
                      <p
                        className="m-0 text-[13px] text-text-tertiary"
                        style={{ fontFamily: "var(--font-inter), sans-serif" }}
                      >
                        {t("playlist.empty_subtitle")}
                      </p>
                    </div>
                  </div>
                ) : search.matches && search.matches.length === 0 ? (
                  <TrackSearchEmpty
                    query={search.activeQuery}
                    onClear={() => search.setQuery("")}
                  />
                ) : (
                  <div
                    ref={trackListContainerRef}
                    className="relative"
                    style={{
                      height: `${rowVirtualizer.getTotalSize()}px`,
                    }}
                  >
                    {isDragging && dropIndex !== null && (
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: `${TRACK_ROW_HEIGHT}px`,
                          transform: `translateY(${dropIndex * TRACK_ROW_HEIGHT}px)`,
                          transition: "transform 180ms cubic-bezier(0.2, 0, 0, 1)",
                          pointerEvents: "none",
                          zIndex: 0,
                        }}
                        className="px-0 py-[2px]"
                      >
                        <ReorderDropPlaceholder />
                      </div>
                    )}

                    {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                      const entry = visibleTracks[virtualRow.index];
                      if (!entry) return null;
                      // original position; equals the row index whenever not filtering
                      const { track, index } = entry;

                      const isThisDragged = isDragging && index === dragIndex;

                      let shiftY = 0;
                      if (
                        isDragging &&
                        dragIndex !== null &&
                        dropIndex !== null &&
                        index !== dragIndex
                      ) {
                        if (dragIndex < dropIndex) {
                          if (index > dragIndex && index <= dropIndex) {
                            shiftY = -TRACK_ROW_HEIGHT;
                          }
                        } else if (dragIndex > dropIndex) {
                          if (index >= dropIndex && index < dragIndex) {
                            shiftY = TRACK_ROW_HEIGHT;
                          }
                        }
                      }

                      // Reordering is only meaningful in the stored (custom)
                      // order; sorted and filtered views are read-only.
                      const canReorder = Boolean(
                        !isLikesMode &&
                          decodedId &&
                          track.playlistItemId &&
                          !isFiltering &&
                          sortKey === "custom",
                      );

                      return (
                        <TrackItem
                          key={track.playlistItemId ?? `${track.id}-${index}`}
                          track={track}
                          trackNumber={index + 1}
                          playlistId={
                            isLikesMode ? undefined : (decodedId ?? undefined)
                          }
                          playlistTitle={viewData.title}
                          playlistCoverUrl={viewData.coverUrl}
                          allTracks={sortedTracks}
                          showReorderHandle={canReorder}
                          highlight={search.activeQuery || undefined}
                          onGrabStart={
                            canReorder && !isDragging
                              ? (event) => handleCardGrab(index, track, event)
                              : undefined
                          }
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${
                              virtualRow.start - listScrollMargin + shiftY
                            }px)`,
                            transition: isDragging
                              ? "transform 180ms cubic-bezier(0.2, 0, 0, 1)"
                              : undefined,
                            opacity: isThisDragged ? 0 : 1,
                            zIndex: 1,
                          }}
                        />
                      );
                    })}
                  </div>
                )}

                {isDragging && draggedItem && (
                  <FloatingDragCard
                    x={pointerPos.x}
                    y={pointerPos.y}
                    offsetX={grabOffset.x}
                    offsetY={grabOffset.y}
                    width={itemWidth}
                  >
                    <SongCardWithMenu
                      id={draggedItem.id}
                      title={draggedItem.title}
                      artists={draggedItem.artists}
                      artistId={draggedItem.artistId}
                      artistList={draggedItem.artistList}
                      coverUrl={draggedItem.coverUrl || viewData.coverUrl}
                      trackNumber={
                        dragIndex !== null ? dragIndex + 1 : undefined
                      }
                      playlistId={
                        isLikesMode ? undefined : (decodedId ?? undefined)
                      }
                      playlistItemId={draggedItem.playlistItemId}
                      playlistTitle={viewData.title}
                      duration={
                        draggedItem.durationMs
                          ? `${Math.floor(draggedItem.durationMs / 60000)}:${String(
                              Math.floor((draggedItem.durationMs % 60000) / 1000),
                            ).padStart(2, "0")}`
                          : undefined
                      }
                      durationMs={draggedItem.durationMs}
                      explicit={draggedItem.explicit}
                      className="bg-transparent"
                    />
                  </FloatingDragCard>
                )}
              </div>
            </div>
          )}

        </div>
      </div>

      {!skeletonExited && (
        <div
          className={`pointer-events-none absolute inset-0 z-10 overflow-hidden transition-opacity duration-200 ease-out ${
            isReady ? "opacity-0" : "opacity-100"
          }`}
          onTransitionEnd={() => setSkeletonExited(true)}
        >
          <PlaylistPageSkeleton />
        </div>
      )}

      {decodedId && !isLikesMode && (
        <PlaylistCollaboratorsDialog
          open={collaboratorsOpen}
          onOpenChange={setCollaboratorsOpen}
          playlistId={decodedId}
          isShared={isSharedPlaylist}
        />
      )}
    </div>
  );
}

export default function LibraryPlaylistPage() {
  return (
    <Suspense fallback={<PlaylistPageSkeleton />}>
      <LibraryPlaylistContent />
    </Suspense>
  );
}
