import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/languages";
import Dialog from "@/shared/ui/Dialog";
import Button from "@/shared/ui/Button";
import { useModalStore } from "@/features/library/store/modalStore";
import { useCoverSrc } from "@/features/covers";
import { useIsTrackLiked, useLikeTrack, useUnlikeTrack } from "@/features/library/hooks";
import { useDeviceControlStore } from "../store/deviceControlStore";
import { disconnectController, sendControl } from "../controller";
import { remotePositionMs } from "../protocol";
import type { Track } from "@/shared/types";
import {
  ArrowDownLine,
  ArrowUpLine,
  CloseLine,
  HeartFill,
  HeartLine,
  PauseFill,
  PlayFill,
  RemoteControlLine,
} from "@mingcute/react";
import { SkipNext, SkipPrevious, VolumeLoud } from "@solar-icons/react";

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function SeekBar({
  value,
  max,
  onCommit,
}: {
  value: number;
  max: number;
  onCommit: (ms: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const msFromClientX = (clientX: number): number => {
    const el = ref.current;
    if (!el || max <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * max;
  };

  const shown = drag ?? value;
  const pct = max > 0 ? Math.min(100, (shown / max) * 100) : 0;

  return (
    <div
      ref={ref}
      className="relative flex h-[22px] w-full items-center touch-none cursor-pointer"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(msFromClientX(e.clientX));
      }}
      onPointerMove={(e) => {
        if (drag !== null) setDrag(msFromClientX(e.clientX));
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        onCommit(drag);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <div className="w-full h-[4px] rounded-full bg-border-alpha-20 overflow-hidden">
        <div className="h-full bg-text-primary" style={{ width: `${pct}%` }} />
      </div>
      <span
        className="absolute top-[9px] h-[10px] w-[10px] rounded-full bg-text-primary"
        style={{ left: `calc(${pct}% - 5px)` }}
      />
    </div>
  );
}

function VolumeBar({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (volume: number) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;

  const commit = (volume: number) => {
    setDrag(null);
    onCommit(volume);
  };

  return (
    <div className="flex items-center gap-[8px]">
      <VolumeLoud size={16} className="text-text-tertiary shrink-0" />
      <div className="relative flex-1 h-[22px] flex items-center touch-none cursor-pointer">
        <div className="w-full h-[4px] rounded-full bg-border-alpha-20 overflow-hidden">
          <div className="h-full bg-text-primary" style={{ width: `${Math.min(100, value * 100)}%` }} />
        </div>
        <span
          className="absolute top-[9px] h-[10px] w-[10px] rounded-full bg-text-primary"
          style={{ left: `${Math.min(100, value * 100)}%` }}
        />
        <input
          type="range"
          aria-label="volume"
          min={0}
          max={1}
          step={0.01}
          value={shown}
          onChange={(e) => {
            const next = Number(e.target.value);
            setDrag(next);
          }}
          onPointerUp={() => {
            if (drag !== null) commit(drag);
          }}
          onPointerCancel={() => setDrag(null)}
          onKeyUp={() => {
            if (drag !== null) commit(drag);
          }}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>
      <span className="text-text-secondary text-[11.5px] font-mono w-[34px] text-right shrink-0">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

function QueueRow({
  track,
  isCurrent,
  canMoveUp,
  canMoveDown,
  onJump,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  track: Track;
  isCurrent: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onJump: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const cover = useCoverSrc(track.coverUrl);
  return (
    <div className="flex items-center gap-[10px] rounded-lg bg-border-alpha-10 px-[10px] py-[8px]">
      <div className="w-[38px] h-[38px] rounded-md overflow-hidden bg-bg-primary shrink-0 relative">
        {cover ? <img src={cover} alt="" className="w-full h-full object-cover" /> : null}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-[1px]">
        <span className={`text-[12.5px] font-[500] truncate ${isCurrent ? "text-text-primary" : "text-text-secondary"}`}>
          {track.title}
        </span>
        <span className="text-[11px] text-text-tertiary truncate">{track.artists}</span>
      </div>
      {!isCurrent ? (
        <div className="flex items-center gap-[2px] shrink-0">
          <button type="button" aria-label={t("devices.move_up")} disabled={!canMoveUp} onClick={onMoveUp} className="p-[4px] rounded-md text-text-tertiary hover:text-text-primary hover:bg-border-alpha-14 disabled:opacity-30 cursor-pointer border-0 bg-transparent">
            <ArrowUpLine size={14} />
          </button>
          <button type="button" aria-label={t("devices.move_down")} disabled={!canMoveDown} onClick={onMoveDown} className="p-[4px] rounded-md text-text-tertiary hover:text-text-primary hover:bg-border-alpha-14 disabled:opacity-30 cursor-pointer border-0 bg-transparent">
            <ArrowDownLine size={14} />
          </button>
          <button type="button" aria-label={t("devices.remove")} onClick={onRemove} className="p-[4px] rounded-md text-text-tertiary hover:text-[#E81123] hover:bg-border-alpha-14 cursor-pointer border-0 bg-transparent">
            <CloseLine size={14} />
          </button>
        </div>
      ) : null}
      <button type="button" aria-label={t("devices.jump")} onClick={onJump} className="p-[4px] rounded-md text-text-tertiary hover:text-text-primary hover:bg-border-alpha-14 cursor-pointer border-0 bg-transparent">
        <SkipNext size={14} />
      </button>
    </div>
  );
}

export default function DeviceControlSheet() {
  const { t } = useTranslation();
  const open = useDeviceControlStore((s) => s.open);
  const setOpen = useDeviceControlStore((s) => s.setOpen);
  const phase = useDeviceControlStore((s) => s.controllerPhase);
  const controllerError = useDeviceControlStore((s) => s.controllerError);
  const hostName = useDeviceControlStore((s) => s.hostName);
  const remote = useDeviceControlStore((s) => s.remote);

  const isLiked = useIsTrackLiked(remote?.track?.id);
  const likeMutation = useLikeTrack();
  const unlikeMutation = useUnlikeTrack();

  const setRemotePosition = useDeviceControlStore((s) => s.setRemotePosition);
  const setRemoteVolume = useDeviceControlStore((s) => s.setRemoteVolume);

  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (phase !== "connected" || !remote || !remote.playing) return;
    const timer = window.setInterval(() => setNowTick((n) => n + 1), 500);
    return () => window.clearInterval(timer);
  }, [phase, remote]);

  const isPlaying = remote?.playing ?? false;
const cover = useCoverSrc(remote?.track?.coverUrl ?? undefined);

  const toggleLike = () => {
    const track = remote?.track;
    if (!track) return;
    if (isLiked) {
      unlikeMutation.mutate(track.id);
    } else {
      likeMutation.mutate(track.id);
    }
  };

  const commitSeek = (ms: number) => {
    sendControl({ a: "seek", positionMs: Math.round(ms) });
    setRemotePosition(Math.round(ms));
  };

  const commitVolume = (volume: number) => {
    sendControl({ a: "volume", volume });
    setRemoteVolume(volume);
  };

  const phaseConnected = phase === "connected";

  const timeline = useMemo(
    () => ({
      positionMs: remote ? remotePositionMs(remote, Date.now()) : 0,
      durationMs: remote?.durationMs || remote?.track?.durationMs || 0,
    }),
    // `nowTick` forces a fresh read of the clock while playback advances.
    [remote, nowTick],
  );
  const positionMs = timeline.positionMs;
  const durationMs = timeline.durationMs;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }} maxWidth={460} className="pt-[18px]">
      <div className="flex flex-col max-h-[80dvh] md:max-h-[70dvh]">
        <div className="flex items-start gap-[10px] pb-[12px] border-b border-solid border-border-primary">
          <span className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center bg-border-alpha-14 shrink-0">
            <RemoteControlLine size={17} />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-text-primary text-[14px] m-0 font-[600] tracking-[-0.01em]">{t("devices.remote_title")}</h3>
            <p className="text-text-tertiary text-[12px] m-0 mt-[2px] leading-snug truncate">
              {phaseConnected && hostName ? t("devices.remote_playing_on", { name: hostName }) : t("devices.remote_subtitle")}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setOpen(false)}
            className="shrink-0 w-[28px] h-[28px] inline-flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-border-alpha-14 transition-colors border-0 bg-transparent p-0 cursor-pointer"
          >
            <CloseLine size={16} />
          </button>
        </div>

        {phaseConnected && remote ? (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto pt-[12px]">
              <div className="flex flex-col items-center gap-[10px] pb-[12px] text-center">
                <div className="relative w-[150px] h-[150px] rounded-[14px] overflow-hidden bg-bg-primary shrink-0 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
          {cover ?? ""}
                </div>
                <div className="flex flex-col gap-[2px] w-full max-w-[300px] px-[6px]">
                  <span className="text-text-primary text-[15px] font-[600] truncate">{remote.track?.title ?? t("devices.nothing_playing")}</span>
                  <span className="text-text-secondary text-[12.5px] truncate">{remote.track?.artists ?? ""}</span>
                </div>

                <div className="w-full max-w-[340px] px-[6px] pt-[2px] pb-[10px] flex flex-col gap-[8px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-[500] text-text-tertiary uppercase tracking-[0.05em]">{formatClock(positionMs)}</span>
                    <span className="text-[11px] font-[500] text-text-tertiary uppercase tracking-[0.05em]">{formatClock(durationMs)}</span>
                  </div>
                  <SeekBar value={positionMs} max={Math.max(0, durationMs)} onCommit={commitSeek} />
                  <div className="flex items-center justify-center gap-[14px]">
                    <button type="button" aria-label={t("devices.previous")} onClick={() => sendControl({ a: "prev" })} className="p-[8px] rounded-full text-text-secondary hover:text-text-primary hover:bg-border-alpha-14 transition-colors cursor-pointer border-0 bg-transparent">
                      <SkipPrevious size={20} weight="Bold" />
                    </button>
                    <button type="button" aria-label={isPlaying ? t("devices.pause") : t("devices.play")} onClick={() => sendControl({ a: isPlaying ? "pause" : "play" })} className="w-[52px] h-[52px] rounded-full bg-btn-primary-bg text-btn-primary-text border-none flex items-center justify-center cursor-pointer active:scale-[0.95]">
                      {isPlaying ? <PauseFill size={20} /> : <PlayFill size={20} />}
                    </button>
                    <button type="button" aria-label={t("devices.next")} onClick={() => sendControl({ a: "next" })} className="p-[8px] rounded-full text-text-secondary hover:text-text-primary hover:bg-border-alpha-14 transition-colors cursor-pointer border-0 bg-transparent">
                      <SkipNext size={20} weight="Bold" />
                    </button>
                  </div>
                  <div className="flex items-center justify-between pt-[2px]">
                    <button
                      type="button"
                      aria-label={isLiked ? t("devices.unlike") : t("devices.like")}
                      onClick={toggleLike}
                      className="flex items-center gap-[6px] px-[12px] py-[7px] rounded-full border border-border-primary bg-bg-primary cursor-pointer transition-colors hover:border-text-secondary"
                    >
                      {isLiked ? <HeartFill size={13} /> : <HeartLine size={13} />}
                      <span className="text-[12px] font-[500] text-text-secondary">{isLiked ? t("devices.unlike") : t("devices.like")}</span>
                    </button>
                    <div className="flex-1 max-w-[220px] ml-[10px]">
                      <VolumeBar value={remote.volume} onCommit={commitVolume} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-[10px] flex flex-col gap-[6px]">
                <span className="text-[11px] font-[600] uppercase tracking-[0.07em] text-text-tertiary">{t("devices.up_next")}</span>
                {remote.queue.length === 0 ? (
                  <span className="text-[12.5px] text-text-tertiary px-[2px]">{t("devices.queue_empty")}</span>
                ) : (
                  <div className="flex flex-col gap-[4px] max-h-[200px] overflow-y-auto pr-[2px]">
                    {remote.queue.map((item, index) => (
                      <QueueRow
                        key={`${item.id}-${index}`}
                        track={item}
                        isCurrent={index === remote.currentIndex}
                        canMoveUp={index > 0}
                        canMoveDown={index < remote.queue.length - 1}
                        onJump={() => sendControl({ a: "jump", index })}
                        onMoveUp={() => sendControl({ a: "move", from: index, to: index - 1 })}
                        onMoveDown={() => sendControl({ a: "move", from: index, to: index + 1 })}
                        onRemove={() => sendControl({ a: "remove", index })}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="pt-[10px] border-t border-solid border-border-primary">
              <Button variant="secondary" size="sm" onClick={() => void disconnectController()}>
                {t("devices.disconnect")}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-[12px] py-[28px] px-[20px] text-center">
            <span className="w-[52px] h-[52px] rounded-full flex items-center justify-center bg-border-alpha-14">
              <RemoteControlLine size={24} />
            </span>
            <div className="flex flex-col gap-[4px]">
              <p className="text-text-primary text-[14px] font-[600] m-0">{t("devices.remote_disconnected")}</p>
              {controllerError ? <p className="text-text-tertiary text-[12.5px] leading-snug m-0">{controllerError}</p> : null}
            </div>
            <Button variant="primary" size="sm" onClick={() => useModalStore.getState().openSettings()}>
              {t("settings.devices.open_remote")}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
