import { useState, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import {
  SkipNext,
  SkipPrevious,
  MusicNote,
  Repeat,
  RepeatOne,
  Shuffle,
} from "@solar-icons/react";
import { AddLine, CheckFill, HeartFill, HeartLine, MoonLine } from "@mingcute/react";
import {
  PlayerMorphIcon,
  ICON_PLAY,
  ICON_PAUSE,
} from "./morphPlayerIcons";
import { usePlayerState } from "../hooks/usePlayerState";
import { useSleepTimerRemainingMs } from "../hooks/useSleepTimer";
import { formatSleepRemaining } from "../engine/sleepTimer";
import { playerEngine } from "../engine/playerEngine";
import { isRadioContext, nextRepeatMode } from "../engine/radioMode";
import { useIsTrackLiked, useLikeTrack, useUnlikeTrack } from "@/features/library/hooks";
import { AnimatePresence, motion } from "framer-motion";
import { ArtistLink } from "@/features/artist";
import { useCoverReady, CoverImage } from "@/features/covers";
import { usePartyStore } from "@/features/party/store/partyStore";
import ExplicitBadge from "@/shared/ui/ExplicitBadge";
import { VolumePicker } from "./VolumePicker";
import { TimelineSlider } from "./TimelineSlider";
import { SleepTimerControl } from "./SleepTimerControl";

import { useTranslation } from "@/languages";

const iconButtonClass =
  "inline-flex h-[28px] w-[28px] items-center justify-center text-white opacity-70 transition-all duration-150 ease-out hover:opacity-100 active:scale-[0.94] shrink-0 border-none bg-transparent cursor-pointer";

function PlayPauseIcon({ status }: { status: string }) {
  const loading = status === "loading";
  const playing = status === "playing";
  // keep the morph icon mounted through the loading state (spinner overlays
  // it) — unmounting the icon on "loading" would remount MorphIcon when the
  // track starts, which skips the play -> pause morph animation.
  return (
    <span className="relative flex h-[22px] w-[22px] items-center justify-center">
      <span
        className={`absolute inset-0 flex items-center justify-center ${
          loading ? "opacity-0" : ""
        } transition-transform ${playing ? "" : "translate-x-[1px]"}`}
      >
        <PlayerMorphIcon
          icon={playing ? ICON_PAUSE : ICON_PLAY}
          size={22}
        />
      </span>
      {loading && (
        <span
          className="absolute h-[18px] w-[18px] animate-spin rounded-full border-[2px] border-current border-t-transparent"
          aria-label="Loading playback"
        />
      )}
    </span>
  );
}

interface PlayerUiElementsProps {
  onDuration?: (duration: number) => void;
  onClose?: () => void;
}

export function PlayerUiElements({
  onDuration: _onDuration,
  onClose,
}: PlayerUiElementsProps) {
  const player = usePlayerState();
  // Transport is the host's while this device rides along as a guest.
  const partyGuest = usePartyStore((s) => s.role === "guest");
  const [sleepOpen, setSleepOpen] = useState(false);
  const sleepRemaining = useSleepTimerRemainingMs();

  const track = player.currentTrack;
  const coverUrl = track?.coverUrl || "";
  const trackTitle = track?.title || "";
  const trackArtists = track?.artists || "";

  const isLiked = useIsTrackLiked(track?.id);
  const likeMutation = useLikeTrack();
  const unlikeMutation = useUnlikeTrack();
  const togglingRef = useRef(false);

  const handleLikeToggle = useCallback(() => {
    if (!track || togglingRef.current) return;
    togglingRef.current = true;
    const onSettled = () => {
      togglingRef.current = false;
    };
    if (isLiked) {
      unlikeMutation.mutate(track.id, { onSettled });
    } else {
      likeMutation.mutate(track.id, { onSettled });
    }
  }, [track, isLiked, likeMutation, unlikeMutation]);

  const isCoverLoaded = useCoverReady(coverUrl);

  const { t } = useTranslation();

  return (
    <>
      {/* Artwork (Compact, flat, no drop shadows) */}
      <div
        className={`relative shrink-0 overflow-hidden rounded-xl w-[min(280px,44vh,72vw)] h-[min(280px,44vh,72vw)] bg-black/20 ${
          coverUrl && !isCoverLoaded ? "animate-pulse" : ""
        }`}
      >
        <AnimatePresence>
          <motion.div
            key={track?.id || coverUrl || "empty"}
            initial={{ opacity: 0, filter: "blur(8px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, filter: "blur(8px)" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute inset-0"
          >
            {coverUrl ? (
              <CoverImage
                key={coverUrl}
                src={coverUrl}
                alt={trackTitle}
                fill
                sizes="280px"
                priority
                unoptimized
                className="rounded-xl object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-white/5 text-white/40">
                <MusicNote size={64} />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        {/* like button on the cover corner (no tooltip; aria-label names it) */}
        <button
          type="button"
          aria-label={isLiked ? t("common.unlike") : t("common.like")}
          className={`absolute bottom-2.5 left-2.5 z-20 inline-flex h-[30px] w-[30px] items-center justify-center rounded-full transition-colors duration-200 ease-out active:scale-[0.92] bg-black/40 backdrop-blur-md border-none hover:bg-black/60 ${
            isLiked ? "text-white" : "text-white/70 hover:text-white"
          }`}
          onClick={handleLikeToggle}
          style={{ cursor: "pointer" }}
        >
          {/* subtle crossfade: outline heart out, filled heart in with a slight scale */}
          <motion.div
            initial={false}
            animate={{ scale: isLiked ? 0.85 : 1, opacity: isLiked ? 0 : 1 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <HeartLine size={16} />
          </motion.div>
          <motion.div
            initial={false}
            animate={{ scale: isLiked ? 1 : 0.75, opacity: isLiked ? 1 : 0 }}
            transition={
              isLiked
                ? { type: "spring", stiffness: 500, damping: 30, mass: 0.6 }
                : { duration: 0.16, ease: "easeOut" }
            }
            className="absolute inset-0 flex items-center justify-center"
          >
            <HeartFill size={16} />
          </motion.div>
        </button>
      </div>

      {/* Track info */}
      <div className="w-full md:w-[280px] flex items-start justify-center min-w-0 px-4">
        <div className="flex flex-col gap-[2px] min-w-0 text-center">
          <p
            className="m-0 text-[15px] font-[600] text-white flex items-center justify-center gap-[6px] max-w-[min(280px,82vw)]"
            style={{ letterSpacing: "-0.03em" }}
          >
            <span className="min-w-0 truncate">{trackTitle}</span>
          </p>
          <p className="m-0 flex items-center justify-center gap-[5px] text-[12px] text-white/60 leading-snug max-w-[320px] overflow-hidden">
            {track?.explicit && (
              <ExplicitBadge className="!bg-white/60 !text-black !pb-0 !leading-none shrink-0" />
            )}
            <ArtistLink
              name={trackArtists}
              artistId={track?.artistId}
              artistList={track?.artistList}
              onNavigate={() => {
                if (location.pathname !== "/player") {
                  onClose?.();
                }
              }}
              className="text-white/60"
            />
          </p>
        </div>
      </div>

      {/* Timeline (Compact, with smooth spring pill, no thumb) */}
      <TimelineSlider
        positionMs={player.positionMs}
        durationMs={player.durationMs}
        onSeek={(pos) => playerEngine.seek(pos)}
        showTime
        size="md"
        className="w-[min(320px,84vw)] md:w-[320px]"
      />

      {/* Primary Playback Controls */}
      <div className="flex items-center gap-[14px]">
        <button
          type="button"
          aria-label={player.shuffle ? t("player.shuffle_on") : t("player.shuffle_off")}
          onClick={() => playerEngine.setShuffle(!player.shuffle)}
          className={`${iconButtonClass} ${
            player.shuffle ? "!text-white !opacity-100" : "!text-white/40"
          }`}
        >
          <Shuffle size={18} weight="Outline" />
        </button>

        <button
          type="button"
          aria-label="Previous track"
          disabled={partyGuest}
          onClick={() => void playerEngine.skipPrevious()}
          className={`${iconButtonClass} disabled:opacity-40`}
        >
          <SkipPrevious size={20} weight="Bold" />
        </button>

        <button
          type="button"
          aria-label={player.status === "playing" ? "Pause" : "Play"}
          disabled={partyGuest}
          onClick={() => void playerEngine.togglePlayPause()}
          className="inline-flex h-[36px] w-[36px] items-center justify-center text-white opacity-85 transition-all duration-150 ease-out hover:opacity-100 active:scale-[0.94] shrink-0 border-none bg-transparent cursor-pointer disabled:opacity-40"
        >
          <PlayPauseIcon status={player.status} />
        </button>

        <button
          type="button"
          aria-label="Next track"
          disabled={partyGuest}
          onClick={() => void playerEngine.skipNext()}
          className={`${iconButtonClass} disabled:opacity-40`}
        >
          <SkipNext size={20} weight="Bold" />
        </button>

        <button
          type="button"
          aria-label="Repeat"
          onClick={() =>
            playerEngine.setRepeat(
              // radio has no repeat-all: it refills instead of looping
              nextRepeatMode(player.repeat, isRadioContext(player.playbackContext)),
            )
          }
          className={`${iconButtonClass} ${
            player.repeat !== "off" ? "!text-white !opacity-100" : "!text-white/40"
          }`}
        >
          {player.repeat === "one" ? (
            <RepeatOne size={18} />
          ) : (
            <Repeat size={18} />
          )}
        </button>

        {/* Sleep timer */}
        <div className="relative">
          <button
            type="button"
            aria-label={t("player.sleep_timer.title")}
            title={
              sleepRemaining > 0
                ? `${t("player.sleep_timer.title")} — ${formatSleepRemaining(sleepRemaining)}`
                : t("player.sleep_timer.title")
            }
            onClick={() => setSleepOpen((v) => !v)}
            className={`${iconButtonClass} ${
              sleepRemaining > 0 ? "!text-white !opacity-100" : "!text-white/40"
            }`}
          >
            <MoonLine size={18} />
          </button>

          {sleepOpen && (
            <div
              className="fixed inset-0 z-40"
              onClick={() => setSleepOpen(false)}
              aria-hidden
            />
          )}
          <AnimatePresence>
            {sleepOpen && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.98 }}
                transition={{ duration: 0.14, ease: "easeOut" }}
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-50 rounded-xl border border-white/10 bg-bg-panel/95 backdrop-blur px-3 py-2 shadow-lg"
              >
                <SleepTimerControl onDone={() => setSleepOpen(false)} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Volume (Compact smooth slider, size sm) */}
      <VolumePicker className="w-[180px]" size="sm" />
    </>
  );
}

export default PlayerUiElements;
