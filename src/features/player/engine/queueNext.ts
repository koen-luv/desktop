import type { Track } from "@/shared/types";
import { isRadioContext } from "./radioMode";

/**
 * Queue-advance rules, extracted so the engine and the playback runtimes agree
 * on what "the next track" is. The crossfade trigger uses this to decide which
 * song to overlap *before* the queue actually advances — it must return
 * exactly what `skipNext(isAutoEnd)` will pick, or the blend would hand over
 * to a different song than the queue lands on.
 */

export interface QueuePositionSnapshot {
  queue: Track[];
  currentIndex: number;
  repeat: "off" | "all" | "one";
  playbackContext: string | null | undefined;
}

export function computeNextIndex(
  state: QueuePositionSnapshot,
  isAutoEnd: boolean = false,
): number | null {
  const queueSize = state.queue.length;
  if (queueSize === 0 || state.currentIndex < 0) return null;
  if (isAutoEnd && state.repeat === "one") return state.currentIndex;

  if (state.currentIndex + 1 < queueSize) return state.currentIndex + 1;
  // radio never wraps to its first track; skipNext refills it instead
  if (isRadioContext(state.playbackContext)) return null;
  if (state.repeat === "all" || state.repeat === "one") return 0;
  return null;
}

/**
 * The track an auto-advance would play next, or null when the advance would
 * replay the same song (repeat-one) or stop playback. Null means: never start
 * an overlapping crossfade.
 */
export function peekAutoNextTrack(state: QueuePositionSnapshot): Track | null {
  const index = computeNextIndex(state, true);
  if (index === null || index === state.currentIndex) return null;
  return state.queue[index] ?? null;
}
