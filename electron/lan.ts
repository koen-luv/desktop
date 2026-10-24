/**
 * Code-free device control over the local network.
 *
 * The desktop app hosts a tiny HTTP endpoint carrying the WebRTC offer, and a
 * UDP responder that lets phones on the same Wi-Fi find it. No relay, no
 * account, no six-digit code: discovery + SDP exchange stay inside the LAN.
 *
 *   phone → UDP broadcast "LINER_DISCOVER" → { app, name, port }
 *   phone → GET  http://host:47823/offer      → { name, offer }
 *   phone → POST http://host:47823/answer     → host applies the SDP answer
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import os from "node:os";

export interface LanHostInfo {
  name: string;
  port: number;
  addresses: string[];
}

export interface LanDiscoveredHost {
  name: string;
  address: string;
  port: number;
  /** Ephemeral key handed out by UDP discovery; proves the caller is on the LAN. */
  token: string;
}

export const LAN_HTTP_PORT = 47823;
export const LAN_DISCOVERY_PORT = 47901;
const DISCOVERY_TOKEN = "LINER_DISCOVER";
const MAX_BODY_BYTES = 512 * 1024;

type AnswerHandler = (answer: string) => void;

let hostServer: http.Server | null = null;
let discoverySocket: dgram.Socket | null = null;
let currentOffer = "";
let currentName = "Liner";
let sessionToken = "";
let answerHandler: AnswerHandler | null = null;

function privateRemote(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.replace(/^::ffff:/, "");
  if (value === "::1" || value.startsWith("127.") || value.startsWith("169.254.")) return true;
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  );
}

function hasValidToken(url: URL): boolean {
  const supplied = Buffer.from(url.searchParams.get("key") ?? "");
  const expected = Buffer.from(sessionToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

/** Starts (or replaces) the host endpoint and returns where phones can reach it. */
export async function startLanHost(
  name: string,
  inviteCode: string,
  onAnswer: AnswerHandler,
): Promise<LanHostInfo> {
  stopLanHost();
  currentOffer = inviteCode;
  currentName = name.trim() || "Liner";
  sessionToken = randomBytes(16).toString("hex");
  answerHandler = onAnswer;

  const server = http.createServer((req, res) => {
    if (!privateRemote(req.socket.remoteAddress)) {
      json(res, 403, { error: "lan only" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/ping") {
      json(res, 200, { app: "liner", name: currentName, port: LAN_HTTP_PORT });
      return;
    }
    if (!hasValidToken(url)) {
      // Discovery is the only way to learn the key, and browsers cannot read
      // UDP broadcasts, so a random web page on the LAN cannot drive playback.
      json(res, 403, { error: "forbidden" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/offer") {
      json(res, 200, { app: "liner", name: currentName, offer: currentOffer });
      return;
    }
    if (req.method === "POST" && url.pathname === "/answer") {
      void readBody(req)
        .then((body) => {
          const answer = body.trim();
          if (!answer) {
            json(res, 400, { error: "empty answer" });
            return;
          }
          answerHandler?.(answer);
          json(res, 200, { ok: true });
        })
        .catch(() => json(res, 400, { error: "invalid answer" }));
      return;
    }
    json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(LAN_HTTP_PORT, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  hostServer = server;

  const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  udp.on("message", (message, rinfo) => {
    if (message.toString("utf8").trim() !== DISCOVERY_TOKEN) return;
    const reply = Buffer.from(
      JSON.stringify({
        app: "liner",
        name: currentName,
        port: LAN_HTTP_PORT,
        token: sessionToken,
      }),
    );
    try {
      udp.send(reply, rinfo.port, rinfo.address);
    } catch {
      // The phone may have gone away; the next broadcast will retry.
    }
  });
  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(LAN_DISCOVERY_PORT, "0.0.0.0", () => {
      udp.off("error", reject);
      try {
        udp.setBroadcast(true);
      } catch {}
      resolve();
    });
  });
  discoverySocket = udp;

  return { name: currentName, port: LAN_HTTP_PORT, addresses: localAddresses() };
}

export function stopLanHost(): void {
  answerHandler = null;
  currentOffer = "";
  sessionToken = "";
  if (hostServer) {
    try {
      hostServer.close();
    } catch {}
    hostServer = null;
  }
  if (discoverySocket) {
    try {
      discoverySocket.close();
    } catch {}
    discoverySocket = null;
  }
}

/** Broadcasts on the LAN and collects hosts that answer within the timeout. */
export function discoverLanHosts(timeoutMs = 900): Promise<LanDiscoveredHost[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const found = new Map<string, LanDiscoveredHost>();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {}
      resolve([...found.values()]);
    };

    socket.on("message", (message, rinfo) => {
      try {
        const payload = JSON.parse(message.toString("utf8")) as {
          app?: string;
          name?: string;
          port?: number;
          token?: string;
        };
        if (payload.app !== "liner" || typeof payload.port !== "number") return;
        const address = rinfo.address.replace(/^::ffff:/, "");
        found.set(`${address}:${payload.port}`, {
          name: typeof payload.name === "string" ? payload.name : "Liner",
          address,
          port: payload.port,
          token: typeof payload.token === "string" ? payload.token : "",
        });
      } catch {
        // Ignore unrelated UDP traffic.
      }
    });
    socket.on("error", finish);

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {}
      const token = Buffer.from(DISCOVERY_TOKEN);
      const targets = new Set<string>([
        "255.255.255.255",
        ...localAddresses().map((address) => {
          const parts = address.split(".");
          return `${parts[0]}.${parts[1]}.${parts[2]}.255`;
        }),
        "127.0.0.1",
      ]);
      for (const target of targets) {
        try {
          socket.send(token, LAN_DISCOVERY_PORT, target);
        } catch {}
      }
      setTimeout(finish, Math.max(200, timeoutMs));
    });
  });
}
