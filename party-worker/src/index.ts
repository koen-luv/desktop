/**
 * Listen-party relay.
 *
 * A six-digit code cannot carry a WebRTC offer, so this worker parks the offer
 * (and the guest's answer) for ten minutes and hands out a short code instead.
 * One Durable Object per room keeps reads strongly consistent: the guest's
 * answer is visible to the host's very next poll, unlike eventually consistent
 * KV storage. Nothing else is stored and rooms delete themselves on expiry.
 */

const ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const CODE_ATTEMPTS = 6;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface Env {
  ROOMS: DurableObjectNamespace;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: CORS_HEADERS });
}

async function readJson<T>(request: Request): Promise<T | null> {
  const text = await request.text();
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function normalizeCode(raw: string | undefined): string | null {
  const value = (raw ?? "").replace(/\D/g, "");
  return value.length === 6 ? value : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return empty(204);

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    if (url.pathname === "/rooms" && request.method === "POST") {
      const body = await readJson<{ offer?: unknown }>(request);
      if (!body || typeof body.offer !== "string" || body.offer.length === 0) {
        return json({ error: "offer required" }, 400);
      }

      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        // 100000-999999: always six digits, never a leading zero to misread.
        const code = String(100000 + Math.floor(Math.random() * 900000));
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const created = await stub.fetch(
          new Request("https://room/create", {
            method: "POST",
            body: JSON.stringify({ offer: body.offer }),
          }),
        );
        if (created.status === 201) {
          return json({ code, expiresAt: Date.now() + ROOM_TTL_MS });
        }
        if (created.status !== 409) {
          return json({ error: "room could not be created" }, 502);
        }
      }
      return json({ error: "no free code right now" }, 503);
    }

    const match = url.pathname.match(/^\/rooms\/([^/]+)(\/answer)?$/);
    if (!match) return json({ error: "not found" }, 404);

    const code = normalizeCode(match[1]);
    if (!code) return json({ error: "invalid code" }, 400);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const target = match[2] ? "answer" : "room";
    const payload = request.method === "PUT" ? await request.text() : undefined;
    return stub.fetch(
      new Request(`https://room/${target}`, { method: request.method, body: payload }),
    );
  },
};

export class Room {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const method = request.method;

    if (path === "/create" && method === "POST") return this.create(request);
    if (path === "/room" && method === "GET") return this.readOffer();
    if (path === "/room" && method === "DELETE") {
      await this.state.storage.deleteAll();
      return empty(204);
    }
    if (path === "/answer" && method === "GET") return this.readAnswer();
    if (path === "/answer" && method === "PUT") return this.writeAnswer(request);

    return json({ error: "not found" }, 404);
  }

  /** Called once per candidate code; 409 tells the worker to try another. */
  private async create(request: Request): Promise<Response> {
    const existing = await this.state.storage.get<string>("offer");
    if (existing) return json({ error: "room exists" }, 409);

    const body = await readJson<{ offer?: unknown }>(request);
    if (!body || typeof body.offer !== "string" || body.offer.length === 0) {
      return json({ error: "offer required" }, 400);
    }

    const expiresAt = Date.now() + ROOM_TTL_MS;
    await this.state.storage.put({ offer: body.offer, expiresAt });
    await this.state.storage.setAlarm(expiresAt);
    return json({ ok: true }, 201);
  }

  private async readOffer(): Promise<Response> {
    const offer = await this.liveOffer();
    if (!offer) return json({ error: "room not found" }, 404);
    return json({ offer });
  }

  private async writeAnswer(request: Request): Promise<Response> {
    const offer = await this.liveOffer();
    if (!offer) return json({ error: "room not found" }, 404);

    const body = await readJson<{ answer?: unknown }>(request);
    if (!body || typeof body.answer !== "string" || body.answer.length === 0) {
      return json({ error: "answer required" }, 400);
    }

    await this.state.storage.put({ answer: body.answer });
    return empty(204);
  }

  private async readAnswer(): Promise<Response> {
    const offer = await this.liveOffer();
    if (!offer) return json({ error: "room not found" }, 404);

    const answer = await this.state.storage.get<string>("answer");
    if (!answer) return json({ error: "answer not ready" }, 404);
    return json({ answer });
  }

  /** Expired rooms read as missing, so a stale code never resurrects. */
  private async liveOffer(): Promise<string | null> {
    const offer = await this.state.storage.get<string>("offer");
    const expiresAt = await this.state.storage.get<number>("expiresAt");
    if (typeof offer !== "string" || typeof expiresAt !== "number" || expiresAt <= Date.now()) {
      await this.state.storage.deleteAll();
      return null;
    }
    return offer;
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
