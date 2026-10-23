/**
 * Guest queue control for listen parties.
 *
 * The host is authoritative for playback, so a guest never edits its own
 * engine when the host allows control — it sends a `queue-op` over the data
 * channel and the host applies it for everyone (the usual state broadcast
 * then carries the result back). With control off, guests keep whatever
 * read-only behaviour they had.
 *
 * Kept small (store + engine only, no WebRTC graph) so queue UI all over the
 * app can import it without dragging the party transport into every chunk.
 */
import { playerEngine } from "@/features/player/engine/playerEngine";
import type { Track } from "@/shared/types";
import { usePartyStore } from "./store/partyStore";
import type { PartyMessage } from "./partySession";

export type QueueOpMessage = Extract<PartyMessage, { t: "queue-op" }>;

export type GuestQueueOp =
  | { op: "reorder"; from: number; to: number }
  | { op: "remove"; index: number }
  | { op: "add"; track: Track; next: boolean };

/** Guest → host. Returns false when there is nothing to send through. */
export function sendGuestQueueOp(op: GuestQueueOp): boolean {
  const conn = usePartyStore.getState().guestConnection;
  if (!conn?.isOpen) return false;
  return conn.send({ t: "queue-op", ...op });
}

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);

/** Rebuild a Track from a wire payload; anything malformed is dropped. */
function toTrack(raw: unknown): Track | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.title !== "string" || r.title.length === 0) return null;
  return {
    id: r.id,
    title: r.title,
    artists: typeof r.artists === "string" ? r.artists : "",
    coverUrl: typeof r.coverUrl === "string" ? r.coverUrl : "",
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    playCount: 0,
  };
}

/**
 * Host: apply a guest's queue edit locally. Ignored while the host has queue
 * control disabled (the flag can flip between send and arrival), and malformed
 * payloads are dropped — a peer controls the music, not the parser.
 */
export function applyGuestQueueOp(message: QueueOpMessage): void {
  if (!usePartyStore.getState().allowGuestQueueControl) return;

  switch (message.op) {
    case "reorder":
      if (isInt(message.from) && isInt(message.to)) {
        playerEngine.reorderQueue(message.from, message.to);
      }
      break;
    case "remove":
      if (isInt(message.index)) {
        playerEngine.removeFromQueue(message.index);
      }
      break;
    case "add": {
      const track = toTrack(message.track);
      if (!track) return;
      if (message.next) playerEngine.playNext(track);
      else playerEngine.addToQueue(track);
      break;
    }
  }
}
