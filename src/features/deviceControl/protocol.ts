/**
 * Wire protocol for remote device control — the "Spotify Connect" feature.
 *
 * The playing device (usually the PC/Electron app) hosts a link: it shows a
 * six-digit code and parks its WebRTC offer behind it. The controller device
 * (usually the phone) joins with that code, and then:
 *
 *   controller → host: `ctl` frames carrying a ControlAction
 *   host → controller: `state` frames carrying authoritative playback
 *
 * The transport itself is the same peer-to-peer data channel the listen
 * party uses (see `features/party/partySession.ts`), so no backend or native
 * socket is involved — the party relay is only a rendezvous for the SDP
 * offer/answer.
 */

import type { RepeatMode } from "@/features/player/store/playerStore";
import type { Track } from "@/shared/types";

/** Distinct channel label so a device link never collides with a party. */
export const DEVICE_CHANNEL_LABEL = "liner-remote";

export type ControlAction =
  | { a: "toggle" }
  | { a: "play" }
  | { a: "pause" }
  | { a: "next" }
  | { a: "prev" }
  | { a: "seek"; positionMs: number }
  | { a: "volume"; volume: number }
  /** Queue: play the entry at this index. */
  | { a: "jump"; index: number }
  /** Queue: move the entry at `from` to `to`. */
  | { a: "move"; from: number; to: number }
  /** Queue: drop the entry at this index (the playing track is never removed). */
  | { a: "remove"; index: number };

export interface DeviceStateMessage {
  t: "state";
  trackId: string | null;
  /** Index into the queue of the track this state refers to. */
  currentIndex: number;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  playbackRate: number;
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  /** Host Date.now() at production; the controller extrapolates from here. */
  sentAt: number;
  track?: Track;
  queue?: Track[];
  context?: string | null;
  contextCover?: string | null;
}

export type DeviceMessage =
  | DeviceStateMessage
  | { t: "ctl"; action: ControlAction }
  | { t: "hello"; name: string }
  | { t: "bye" };

/** Controller-side view of a `state` frame. */
export interface RemotePlayback {
  trackId: string | null;
  currentIndex: number;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  playbackRate: number;
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  sentAt: number;
  track: Track | null;
  queue: Track[];
  context: string | null;
  contextCover: string | null;
}

export function remoteFromState(message: DeviceStateMessage): RemotePlayback {
  return {
    trackId: message.trackId,
    currentIndex: message.currentIndex,
    positionMs: message.positionMs,
    durationMs: message.durationMs,
    playing: message.playing,
    playbackRate: message.playbackRate,
    volume: message.volume,
    repeat: message.repeat,
    shuffle: message.shuffle,
    sentAt: message.sentAt,
    track: message.track ?? null,
    queue: message.queue ?? [],
    context: message.context ?? null,
    contextCover: message.contextCover ?? null,
  };
}

/** Where the remote playback should be right now, extrapolating from `sentAt`. */
export function remotePositionMs(remote: RemotePlayback, nowMs: number): number {
  const from = !remote.playing ? remote.positionMs : remote.positionMs + Math.max(0, nowMs - remote.sentAt);
  const bounded = remote.durationMs > 0 ? Math.min(remote.durationMs, from) : from;
  return Math.max(0, bounded);
}
