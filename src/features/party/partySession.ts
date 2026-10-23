/**
 * Peer-to-peer listen-party transport. No backend.
 *
 * Connection setup uses the classic manual-signaling WebRTC dance, with the
 * SDP offer/answer carried out-of-band by the users themselves (share sheet,
 * clipboard, chat app — anything). STUN only: ICE reaches across NATs using
 * Google's public STUN server; there is deliberately no TURN relay, which is
 * what would require a server we'd have to run.
 *
 *   host:  createParty()  → invite code (offer)   → share it
 *   guest: joinParty(code) → answer code          → share it back
 *   host:  acceptAnswer(code) → data channel opens → sync flows
 *
 * Codes are `deflate-raw` compressed and base64url-encoded, so a full SDP
 * (usually ~2-4 KB raw) fits in a couple of KB of shareable text.
 */

export const PARTY_CODE_PREFIX = "linerparty1.";

export type PartyRole = "host" | "guest";

/** Wire messages. Host → guest carries authoritative playback state. */
export type PartyMessage =
  | {
      t: "state";
      trackId: string | null;
      positionMs: number;
      playing: boolean;
      playbackRate: number;
      /** Host Date.now() at production; guest extrapolates from here. */
      sentAt: number;
      /** Full track + queue on track/queue change so guests can load it. */
      track?: unknown;
      queue?: unknown[];
      context?: string | null;
      contextCover?: string | null;
    }
  /** Sent by each side once the channel opens, purely for display names. */
  | { t: "hello"; name: string }
  /** Guest → host: a queue edit. Applied by the host only when it allows control. */
  | { t: "queue-op"; op: "reorder"; from: number; to: number }
  | { t: "queue-op"; op: "remove"; index: number }
  | { t: "queue-op"; op: "add"; track: unknown; next: boolean }
  /** Host → guest: whether guests may control the queue right now. */
  | { t: "control"; queue: boolean }
  | { t: "bye" };

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

const ICE_GATHER_TIMEOUT_MS = 4000;
const DATA_CHANNEL_LABEL = "liner-party";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode a session description into a shareable party code. */
export async function encodePartyCode(
  description: RTCSessionDescriptionInit,
): Promise<string> {
  const json = JSON.stringify({ type: description.type, sdp: description.sdp });
  const raw = new TextEncoder().encode(json);
  if (typeof CompressionStream !== "undefined") {
    try {
      const stream = new Blob([raw]).stream().pipeThrough(
        new CompressionStream("deflate-raw"),
      );
      const compressed = new Uint8Array(
        await new Response(stream).arrayBuffer(),
      );
      if (compressed.length < raw.length) {
        return PARTY_CODE_PREFIX + toBase64Url(compressed);
      }
    } catch {
      // Any stream quirk in this runtime: raw JSON still round-trips fine.
    }
  }
  // Fall back to uncompressed (prefix distinguishes nothing; decoder tries
  // inflate first and falls back to the raw JSON on failure).
  return PARTY_CODE_PREFIX + toBase64Url(raw);
}

/** Decode a shareable party code back into a session description. */
export async function decodePartyCode(
  code: string,
): Promise<RTCSessionDescriptionInit> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PARTY_CODE_PREFIX)) {
    throw new Error("party code has an unknown format");
  }
  const bytes = fromBase64Url(trimmed.slice(PARTY_CODE_PREFIX.length));
  let json: string | undefined;
  if (typeof DecompressionStream !== "undefined") {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(
        new DecompressionStream("deflate-raw"),
      );
      const inflated = new TextDecoder().decode(
        await new Response(stream).arrayBuffer(),
      );
      JSON.parse(inflated); // commit only if the inflate actually produced JSON
      json = inflated;
    } catch {
      // Not deflate data (or produced garbage): fall back to raw below.
      json = undefined;
    }
  }
  if (json === undefined) {
    json = new TextDecoder().decode(bytes);
  }
  const parsed = JSON.parse(json) as RTCSessionDescriptionInit;
  if (!parsed || typeof parsed.sdp !== "string" || !parsed.type) {
    throw new Error("party code is missing a session description");
  }
  return parsed;
}

/** Resolve once ICE gathering completes or the timeout elapses (non-trickle). */
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onState);
      window.clearTimeout(timer);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", onState);
    const timer = window.setTimeout(done, ICE_GATHER_TIMEOUT_MS);
  });
}

export interface PartyConnectionHandlers<M extends { t: string } = PartyMessage> {
  onMessage?: (message: M) => void;
  onOpen?: () => void;
  onClose?: (reason: "local" | "remote" | "failed") => void;
  onError?: (error: Error) => void;
}

/**
 * One peer-to-peer link (host side may hold several, one per guest).
 *
 * Generic over the wire message shape so other features (remote device
 * control) reuse the same WebRTC + relay plumbing with their own protocol;
 * party code keeps the default `PartyMessage`.
 */
export class PartyConnection<M extends { t: string } = PartyMessage> {
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private closed = false;

  constructor(
    private readonly handlers: PartyConnectionHandlers<M>,
    asHost: boolean,
    private readonly channelLabel: string = DATA_CHANNEL_LABEL,
  ) {
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (
        this.pc.connectionState === "failed" ||
        this.pc.connectionState === "disconnected"
      ) {
        this.teardown();
        this.handlers.onClose?.("failed");
      }
    };
    if (asHost) {
      const channel = this.pc.createDataChannel(this.channelLabel, {
        ordered: true,
      });
      this.attachChannel(channel);
    } else {
      this.pc.ondatachannel = (event) => this.attachChannel(event.channel);
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => this.handlers.onOpen?.();
    channel.onclose = () => {
      if (this.closed) return;
      const wasLocal = this.closingLocally;
      this.teardown();
      this.handlers.onClose?.(wasLocal ? "local" : "remote");
    };
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as M;
        this.handlers.onMessage?.(message);
      } catch {
        // Ignore malformed frames rather than tearing down the link.
      }
    };
  }

  private closingLocally = false;

  /** Host: create the offer and return its shareable code. */
  async createInviteCode(): Promise<string> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIceGathering(this.pc);
    const local = this.pc.localDescription;
    if (!local) throw new Error("failed to create a party invite");
    return encodePartyCode(local);
  }

  /** Guest: consume the host's invite and return the answer code. */
  async createAnswerCode(inviteCode: string): Promise<string> {
    const offer = await decodePartyCode(inviteCode);
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceGathering(this.pc);
    const local = this.pc.localDescription;
    if (!local) throw new Error("failed to create a party reply");
    return encodePartyCode(local);
  }

  /** Host: apply the guest's reply; the channel opens once ICE connects. */
  async acceptAnswerCode(answerCode: string): Promise<void> {
    const answer = await decodePartyCode(answerCode);
    await this.pc.setRemoteDescription(answer);
  }

  send(message: M): boolean {
    return this.sendPayload(message);
  }

  /** Untyped escape hatch for lifecycle frames (e.g. the closing "bye"). */
  private sendPayload(payload: { t: string }): boolean {
    if (this.channel?.readyState !== "open") return false;
    try {
      this.channel.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  get isOpen(): boolean {
    return this.channel?.readyState === "open";
  }

  close(): void {
    if (this.closed) return;
    this.closingLocally = true;
    this.sendPayload({ t: "bye" });
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel?.close();
    } catch {
      // channel may already be gone
    }
    try {
      this.pc.close();
    } catch {
      // pc may already be gone
    }
  }
}
