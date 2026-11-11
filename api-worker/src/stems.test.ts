import { afterEach, describe, expect, it, vi } from "vitest";
import { handleStemsRequest, stemsStatusResponse } from "./stems";
import type { Env } from "./http";

const env: Env = { STEMS_SERVICE_URL: "https://stems.example.com", STEMS_SERVICE_TOKEN: "t" };

function request(body: unknown): Request {
  return new Request("https://api.example.com/v1/tracks/abc/stems", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "none";
  }
  return "resolved";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stem separation endpoint", () => {
  it("reports unavailability without a configured service", async () => {
    expect(await errorCode(handleStemsRequest(request({ audioUrl: "https://cdn/x" }), {}, "abc"))).toBe(
      "STEMS_UNAVAILABLE",
    );
  });

  it("reports status for the client", async () => {
    const status = stemsStatusResponse(new Request("https://api.example.com/v1/stems/status"), env);
    expect(await status.json()).toMatchObject({ available: true });

    const off = stemsStatusResponse(new Request("https://api.example.com/v1/stems/status"), {});
    expect(await off.json()).toMatchObject({ available: false });
  });

  it("requires a fetchable audio url", async () => {
    expect(await errorCode(handleStemsRequest(request({}), env, "abc"))).toBe("INVALID_INPUT");
  });

  it("forwards to the service and keeps only known stems", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          stems: [
            { name: "vocals", url: "https://cdn/vocals.mp3" },
            { name: "drums", url: "https://cdn/drums.mp3" },
            { name: "kazoo", url: "https://cdn/kazoo.mp3" },
            { name: "bass", url: "not-a-url" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const response = await handleStemsRequest(
      request({ audioUrl: "https://cdn/track.m4a" }),
      env,
      "abc",
    );
    const body = (await response.json()) as { stems: { name: string; url: string }[] };

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://stems.example.com/separate");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t");
    expect(body.stems.map((stem) => stem.name)).toEqual(["vocals", "drums", "other"]);
  });

  it("rejects a service answer with too few stems", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ stems: [{ name: "vocals", url: "https://cdn/v.mp3" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect(await errorCode(handleStemsRequest(request({ audioUrl: "https://cdn/x" }), env, "abc"))).toBe(
      "STEMS_SERVICE_FAILED",
    );
  });

  it("surfaces an unreachable service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await errorCode(handleStemsRequest(request({ audioUrl: "https://cdn/x" }), env, "abc"))).toBe(
      "STEMS_SERVICE_UNREACHABLE",
    );
  });
});
