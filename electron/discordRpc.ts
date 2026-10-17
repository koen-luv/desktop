import net from "node:net";
import path from "node:path";

/**
 * Minimal Discord Rich Presence client over Discord's local IPC.
 *
 * Discord exposes a per-user local socket (a named pipe on Windows, a unix
 * domain socket elsewhere) that speaks a tiny length-prefixed JSON protocol.
 * We talk to it directly with Node's `net` module so there is no runtime
 * dependency and no OAuth flow — this is the same local IPC path the desktop
 * Discord app and clients like `discord-rpc` use.
 *
 * Everything here fails soft: if Discord isn't running, the socket is absent,
 * or the connection drops, we simply retry with backoff and never throw into
 * the app. Presence is a nicety, not something that may crash playback.
 */

// Discord IPC opcodes.
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

export interface DiscordActivityAssets {
  large_image?: string;
  large_text?: string;
  small_image?: string;
  small_text?: string;
}

/** The `activity` object Discord renders on a profile. */
export interface DiscordActivity {
  details?: string;
  state?: string;
  timestamps?: { start?: number; end?: number };
  assets?: DiscordActivityAssets;
  instance?: boolean;
}

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

/** Encodes one Discord IPC frame: [opcode u32le][length u32le][utf8 json]. */
export function encodeFrame(opcode: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload ?? null), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode >>> 0, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

/**
 * Pulls every complete frame off the front of `buffer` and returns them plus
 * any trailing partial bytes (kept for the next chunk). Malformed lengths are
 * treated as a dead connection by the caller, but a short buffer just waits.
 */
export function decodeFrames(buffer: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const opcode = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    if (length > 4 * 1024 * 1024) break; // absurd frame: treat as corrupt
    if (buffer.length - offset - 8 < length) break; // incomplete, wait for more
    frames.push({
      opcode,
      payload: buffer.subarray(offset + 8, offset + 8 + length),
    });
    offset += 8 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * Candidate Discord IPC endpoints, most-likely first. Discord numbers its
 * endpoints `discord-ipc-0`..`9`; the desktop client, PTB and a few sandboxed
 * installs (snap/flatpak) place them in different directories.
 */
export function discordIpcCandidates(platform = process.platform): string[] {
  if (platform === "win32") {
    return Array.from({ length: 10 }, (_, i) => `\\\\.\\pipe\\discord-ipc-${i}`);
  }

  const env = process.env;
  const bases = [
    env.XDG_RUNTIME_DIR,
    env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "app", "com.discordapp.Discord") : undefined,
    env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "snap.discord") : undefined,
    env.TMPDIR,
    env.TMP,
    env.TEMP,
    "/tmp",
  ].filter((dir): dir is string => Boolean(dir));

  const candidates: string[] = [];
  for (const base of bases) {
    for (let i = 0; i < 10; i++) {
      candidates.push(path.join(base, `discord-ipc-${i}`));
    }
  }
  return candidates;
}

type DisconnectFn = () => void;

export class DiscordRpcManager {
  private clientId = "";
  private enabled = false;
  private disposed = false;

  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private connected = false;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 2_000;

  private nonce = 0;
  private lastSentJson: string | null = null;
  private pendingActivity: DiscordActivity | null = null;
  private hasPending = false;

  /** Enables/disables presence and (re)connects when the client id changes. */
  configure(clientId: string, enabled: boolean): void {
    if (this.disposed) return;
    const nextId = (clientId || "").trim();
    const nextEnabled = Boolean(enabled && nextId);
    const changed = nextId !== this.clientId || nextEnabled !== this.enabled;
    this.clientId = nextId;
    this.enabled = nextEnabled;
    if (!changed) return;

    if (!nextEnabled) {
      // Best-effort: clear the old presence before dropping the connection.
      if (this.connected) this.sendActivity(null);
      this.teardown();
      return;
    }
    this.teardown();
    this.connect();
  }

  /** Sets (or clears, with `null`) the presence shown on the user's profile. */
  setPresence(activity: DiscordActivity | null): void {
    if (!this.enabled || this.disposed) return;
    this.pendingActivity = activity;
    this.hasPending = true;
    if (this.connected) this.sendActivity(activity);
  }

  clear(): void {
    this.setPresence(null);
  }

  /** Clears presence and closes the socket. Safe to call on app quit. */
  dispose(): void {
    if (this.disposed) return;
    if (this.connected) this.sendActivity(null);
    this.disposed = true;
    this.teardown();
  }

  /** Exposed for tests/telemetry: whether the Discord handshake completed. */
  isConnected(): boolean {
    return this.connected;
  }

  // --- connection lifecycle -------------------------------------------------

  private connect(): void {
    if (this.disposed || !this.enabled || this.socket) return;
    this.tryConnectAt(discordIpcCandidates(), 0);
  }

  private tryConnectAt(candidates: string[], index: number): void {
    if (this.disposed || !this.enabled) return;
    const target = candidates[index];
    if (!target) {
      this.scheduleReconnect();
      return;
    }

    const socket = net.connect(target);
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      this.clearConnectTimer();
      socket.removeAllListeners();
      socket.destroy();
      if (this.socket === socket) this.socket = null;
      this.tryConnectAt(candidates, index + 1);
    };

    this.connectTimer = setTimeout(fail, 2_500);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      this.clearConnectTimer();
      socket.removeAllListeners();
      this.socket = socket;
      this.onConnected(socket);
    });
    socket.once("error", fail);
  }

  private onConnected(socket: net.Socket): void {
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.lastSentJson = null;

    socket.on("data", (chunk) => this.onData(chunk));
    const onGone = () => this.onClosed(socket);
    socket.once("close", onGone);
    socket.once("error", onGone);

    // Handshake first; Discord replies with a READY dispatch on OP_FRAME.
    this.sendFrame(OP_HANDSHAKE, { v: 1, client_id: this.clientId });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;

    for (const frame of frames) {
      if (frame.opcode === OP_PING) {
        this.sendFrame(OP_PONG, this.safeParse(frame.payload));
        continue;
      }
      if (frame.opcode === OP_CLOSE) {
        this.onClosed(this.socket!);
        return;
      }
      if (frame.opcode !== OP_FRAME) continue;

      const message = this.safeParse(frame.payload) as
        | { evt?: string; data?: unknown }
        | null;
      if (message?.evt === "READY" && !this.connected) {
        this.connected = true;
        this.reconnectDelayMs = 2_000;
        // Flush whatever the renderer last asked for (including a clear).
        if (this.hasPending) this.sendActivity(this.pendingActivity);
      }
    }
  }

  private onClosed(socket: net.Socket): void {
    if (this.socket !== socket) return;
    this.teardownSocket();
    if (this.disposed || !this.enabled) return;
    this.scheduleReconnect();
  }

  private sendActivity(activity: DiscordActivity | null): void {
    const json = JSON.stringify(activity ?? null);
    if (json === this.lastSentJson) return; // avoid hammering Discord's limit
    this.lastSentJson = json;
    this.sendFrame(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: activity ?? null },
      nonce: String(++this.nonce),
    });
  }

  private sendFrame(opcode: number, payload: unknown): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    try {
      socket.write(encodeFrame(opcode, payload));
    } catch {
      // A failed write just means Discord went away; close will follow.
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed || !this.enabled) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelayMs = 2_000;
    this.lastSentJson = null;
    this.teardownSocket();
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.clearConnectTimer();
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private safeParse(payload: Buffer): unknown {
    try {
      return JSON.parse(payload.toString("utf8"));
    } catch {
      return null;
    }
  }
}
