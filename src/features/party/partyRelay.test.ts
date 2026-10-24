import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeRelayRoom,
  createRelayRoom,
  fetchRelayOffer,
  isPartyRelayEnabled,
  normalizeJoinCode,
  submitRelayAnswer,
  waitForRelayAnswer,
} from "./partyRelay";

const RELAY = "https://relay.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("party relay codes", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_PARTY_RELAY_URL", RELAY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("only accepts six digits, tolerating spaces and dashes", () => {
    expect(normalizeJoinCode("123456")).toBe("123456");
    expect(normalizeJoinCode(" 123 456 ")).toBe("123456");
    expect(normalizeJoinCode("123-456")).toBe("123456");
    expect(normalizeJoinCode("12345")).toBeNull();
    expect(normalizeJoinCode("1234567")).toBeNull();
    expect(normalizeJoinCode("linerparty1.abc")).toBeNull();
  });

  it("uses the deployed relay when no URL is configured", () => {
    expect(isPartyRelayEnabled()).toBe(true);
    vi.stubEnv("VITE_PARTY_RELAY_URL", "");
    expect(isPartyRelayEnabled()).toBe(true);
  });

  it("allows a configured relay URL to override the default", async () => {
    vi.stubEnv("VITE_PARTY_RELAY_URL", RELAY);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: "654321" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await createRelayRoom("offer");
    expect(fetchMock.mock.calls[0][0]).toBe(`${RELAY}/rooms`);
  });

  it("posts the offer and returns the room code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: "654321" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createRelayRoom("linerparty1.offer")).resolves.toBe("654321");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RELAY}/rooms`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ offer: "linerparty1.offer" });
  });

  it("reads the parked offer for a code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ offer: "linerparty1.offer" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRelayOffer("123456")).resolves.toBe("linerparty1.offer");
    expect(fetchMock.mock.calls[0][0]).toBe(`${RELAY}/rooms/123456`);
  });

  it("reports an expired code as such instead of returning nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "room not found" }, 404)));
    await expect(fetchRelayOffer("123456")).rejects.toThrow(/not found or expired/);
  });

  it("uploads the guest answer under the same code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitRelayAnswer("123456", "linerparty1.answer");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RELAY}/rooms/123456/answer`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ answer: "linerparty1.answer" });
  });

  it("polls until the host sees an answer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "answer not ready" }, 404))
      .mockResolvedValueOnce(jsonResponse({ answer: "linerparty1.answer" }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = waitForRelayAnswer("123456");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe("linerparty1.answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("stops polling when the host leaves", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));

    const pending = waitForRelayAnswer("123456", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("swallows cleanup failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(closeRelayRoom("123456")).resolves.toBeUndefined();
    await expect(closeRelayRoom(null)).resolves.toBeUndefined();
  });
});
