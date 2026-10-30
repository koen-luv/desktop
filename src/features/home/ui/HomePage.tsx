import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import PopularTracksSection from "./PopularTracksSection";
import DailyMixesSection from "./DailyMixesSection";
import HomePageSkeleton from "./HomePageSkeleton";
import {
  usePopular,
  usePopularTracksOnly,
  usePopularTracksAllTime,
} from "../hooks/usePopularTracks";
import { useRecentlyPlayed } from "../hooks/useRecentlyPlayed";
import { useDailyMixes } from "../hooks/useDailyMixes";
import { useForgottenMemories, useNewReleases } from "../hooks/useHomeExtras";
import { useLikedTracks } from "@/features/library/hooks/useLikedTracks";
import ListeningRecap from "./ListeningRecap";
import { playerEngine } from "@/features/player";
import SongCard from "@/features/player/ui/SongCard";
import SongCardWithMenu from "@/features/player/ui/SongCardWithMenu";
import { useTranslation } from "@/languages";
import { useIsContentTransparent } from "@/features/settings/store/customizationStore";
import SectionHeading from "@/shared/ui/SectionHeading";
import {
  FireFill,
  TrophyFill,
  TimeFill,
  AlbumFill,
  PlaylistFill,
  HeartFill,
  FlashCircleFill,
} from "@mingcute/react";

export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hasCustomBg = useIsContentTransparent();
  const { data: likedData, isLoading: likedLoading } = useLikedTracks();

  const { data: popularItems, isLoading: popularLoading } = usePopular(100);
  const { data: popularTracksOnly, isLoading: tracksLoading } =
    usePopularTracksOnly(20);
  const { data: popularTracksAllTime, isLoading: allTimeLoading } =
    usePopularTracksAllTime(20);
  const { data: recentlyPlayed, isLoading: recentLoading } =
    useRecentlyPlayed(20);
  const { data: dailyMixes } = useDailyMixes();
  const { data: forgottenMemories } = useForgottenMemories(20);
  const { data: newReleases } = useNewReleases(12);

  const isDataLoading =
    tracksLoading ||
    allTimeLoading ||
    popularLoading ||
    recentLoading ||
    likedLoading;

  const popularAlbums =
    popularItems?.filter((it) => it.type === "album") ?? [];
  const popularPlaylists =
    popularItems?.filter((it) => it.type === "playlist") ?? [];

  // Ambient time-of-day colored glow
  const glowClass = useMemo(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) {
      return "from-amber-500/20 via-orange-500/10 to-transparent";
    } else if (hour >= 12 && hour < 17) {
      return "from-amber-400/20 via-sky-500/10 to-transparent";
    } else if (hour >= 17 && hour < 22) {
      return "from-rose-500/20 via-purple-500/10 to-transparent";
    }
    return "from-indigo-600/25 via-violet-600/15 to-transparent";
  }, []);

  // Quick mix items: up to 5 recently played items (tracks or albums)
  const quickRecentItems = useMemo(() => {
    return (recentlyPlayed || []).slice(0, 5);
  }, [recentlyPlayed]);

  const hasEnoughQuickData = quickRecentItems.length >= 5;

  const isReady = !isDataLoading;
  const [skeletonExited, setSkeletonExited] = useState(() => !isDataLoading);

  useEffect(() => {
    if (isReady && !skeletonExited) {
      const timer = setTimeout(() => {
        setSkeletonExited(true);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [isReady, skeletonExited]);

  const quickCardClass = hasCustomBg
    ? "apple-glass-action"
    : "bg-bg-elevated/80 shadow-[inset_0_0_0_1px_var(--border-primary)] hover:bg-bg-elevated hover:shadow-e1 transition-[background-color,box-shadow] duration-200 ease-[var(--motion-ease)]";

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return t("home.goodMorning") || "Good morning";
    if (hour >= 12 && hour < 18) return t("home.goodAfternoon") || "Good afternoon";
    if (hour >= 18 && hour < 23) return t("home.goodEvening") || "Good evening";
    return t("home.goodNight") || "Good night";
  }, [t]);

  const todayLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date()),
    [],
  );

  return (
    <div className="relative h-full w-full overflow-y-auto overflow-x-hidden bg-transparent">

      <div
        data-window-drag
        className="sticky top-0 z-20 h-[32px] w-full shrink-0 select-none pointer-events-auto"
        style={{ marginBottom: "-32px" }}
        aria-hidden="true"
      />
      {!hasCustomBg && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute -top-16 -left-16 w-[520px] h-[280px] bg-gradient-to-br ${glowClass} blur-[64px] opacity-50`}
        />
      )}

      <header className="relative z-1 px-4 md:px-8 pt-[44px] md:pt-[52px] pb-[6px]">
        <p className="m-0 text-[11px] font-[600] uppercase tracking-[0.16em] text-text-tertiary">
          {todayLabel}
        </p>
        <h1 className="m-0 mt-[8px] text-[34px] md:text-[42px] font-[650] leading-[1.02] tracking-[-0.045em] text-text-primary">
          {greeting}
        </h1>
      </header>

      <div className="relative z-1 grid grid-cols-1 items-start w-full">
        {/* Real Content Layer */}
        {isReady && (
          <div className="col-start-1 row-start-1 w-full pb-[16px]">
            {hasEnoughQuickData && (
              <div className="flex flex-col">
              <SectionHeading
                title={t("home.speedDial") || "Speed dial"}
                icon={<FlashCircleFill className="h-[17px] w-[17px] text-amber-400" />}
                className="mt-[22px] px-4 md:px-8"
              />

                <div className="px-4 md:px-8 mt-[14px] relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[10px]">
                  <SongCard
                    title={t("library.liked_songs")}
                    artists={`${likedData.total} ${likedData.total === 1 ? t("library.song") : t("library.songs")}`}
                    artistsClickable={false}
                    coverUrl=""
                    icon={<HeartFill size={22} className={hasCustomBg ? "text-white/80" : "text-text-tertiary"} />}
                    onPlay={() => navigate("/library/playlist?id=likes")}
                    compact
                    className={quickCardClass}
                  />

                  {/* Recently Played Quick Cards */}
                  {quickRecentItems.map((entry, idx) => {
                    if (entry.type === "album") {
                      const album = entry.item;
                      return (
                        <SongCardWithMenu
                          key={`quick-album-${album.id}-${idx}`}
                          id={album.id}
                          title={album.title}
                          artists={album.artist}
                          coverUrl={album.coverUrl ?? ""}
                          onPlay={() =>
                            navigate(
                              `/collection?type=album&id=${encodeURIComponent(album.id)}`,
                            )
                          }
                          searchType="album"
                          compact
                          className={quickCardClass}
                        />
                      );
                    }
                    if (entry.type === "track") {
                      const track = entry.item;
                      return (
                        <SongCardWithMenu
                          key={`quick-track-${track.id}-${idx}`}
                          id={track.id}
                          title={track.title}
                          artists={track.artists}
                          coverUrl={track.coverUrl ?? ""}
                          durationMs={track.durationMs}
                          explicit={track.explicit}
                          onPlay={() => {
                            void playerEngine.playTrack(
                              track,
                              [track],
                              `${track.title} Radio`,
                              track.coverUrl,
                            );
                          }}
                          searchType="track"
                          compact
                          className={quickCardClass}
                        />
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            )}

            {/* Daily Mixes (Made For You) */}
            {dailyMixes && dailyMixes.length > 0 && (
              <DailyMixesSection
                mixes={dailyMixes}
                headingMarginTop="mt-[30px]"
              />
            )}

            <ListeningRecap />

          {/* Listening Right Now (Trending Chart) */}
          {popularTracksOnly && popularTracksOnly.length > 0 && (
            <PopularTracksSection
              title={t("home.whatEveryonesOn")}
              icon={<FireFill className="w-5 h-5 text-amber-500" />}
              items={popularTracksOnly}
              headingMarginTop="mt-[30px]"
            />
          )}

          {/* Jump Back In (History) */}
          {recentlyPlayed && recentlyPlayed.length > 0 && (
            <PopularTracksSection
              title={t("home.jumpBackIn")}
              icon={<TimeFill className="w-5 h-5 text-sky-400" />}
              items={recentlyPlayed}
              headingMarginTop="mt-[30px]"
            />
          )}

          {/* Most Listened of All Time */}
          {popularTracksAllTime && popularTracksAllTime.length > 0 && (
            <PopularTracksSection
              title={t("home.mostListened")}
              icon={<TrophyFill className="w-5 h-5 text-yellow-500" />}
              items={popularTracksAllTime}
              headingMarginTop="mt-[30px]"
            />
          )}

          {/* Top Albums */}
          {popularAlbums && popularAlbums.length > 0 && (
            <PopularTracksSection
              title={t("home.popularAlbums")}
              icon={<AlbumFill className="w-5 h-5 text-emerald-400" />}
              items={popularAlbums}
              headingMarginTop="mt-[30px]"
            />
          )}

          {/* Popular Playlists */}
          {popularPlaylists && popularPlaylists.length > 0 && (
            <PopularTracksSection
              title={t("home.popularPlaylists")}
              icon={<PlaylistFill className="w-5 h-5 text-rose-400" />}
              items={popularPlaylists}
              headingMarginTop="mt-[30px]"
            />
          )}

          {newReleases.length > 0 && (
            <PopularTracksSection
              title={t("home.newReleases") || "New releases"}
              icon={<AlbumFill className="w-5 h-5 text-violet-400" />}
              items={newReleases}
              headingMarginTop="mt-[30px]"
            />
          )}

          {forgottenMemories.length > 0 && (
            <PopularTracksSection
              title={t("home.forgottenMemories") || "Forgotten memories"}
              icon={<TimeFill className="w-5 h-5 text-sky-400" />}
              items={forgottenMemories}
              headingMarginTop="mt-[30px]"
            />
          )}
        </div>
      )}

      {/* Direct Crossfade Skeleton Layer */}
      {!skeletonExited && (
        <div
          className={`col-start-1 row-start-1 w-full z-10 transition-opacity duration-300 ease-out ${
            isReady ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"
          }`}
          onTransitionEnd={() => setSkeletonExited(true)}
        >
          <HomePageSkeleton glowClass={glowClass} showQuickGrid={hasEnoughQuickData} />
        </div>
      )}
      </div>
    </div>
  );
}
