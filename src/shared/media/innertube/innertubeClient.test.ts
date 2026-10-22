import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformFetch } from "@/platform/http";
import { getClientVisitorData } from "@/shared/api/visitorSession";
import { InnertubeError, postInnertube } from "./innertubeClient";

vi.mock("@/platform/http", () => ({ platformFetch: vi.fn() }));
vi.mock("@/shared/api/visitorSession", () => ({ getClientVisitorData: vi.fn() }));

const fetchMock = vi.mocked(platformFetch);
const visitorMock = vi.mocked(getClientVisitorData);

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("postInnertube", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    visitorMock.mockReset();
    visitorMock.mockResolvedValue("VD123");
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
  });

  it("sends Innertube requests through the platform HTTP layer", async () => {
    await postInnertube("next", { videoId: "aaaaaaaaaaa", playlistId: "RDAMVMaaaaaaaaaaa" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://music.youtube.com/youtubei/v1/next?prettyPrint=false");
    expect(init?.method).toBe("POST");

    const headers = init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-youtube-client-name"]).toBe("67");
    expect(headers["x-goog-visitor-id"]).toBe("VD123");

    const body = JSON.parse(String(init?.body)) as {
      videoId: string;
      playlistId: string;
      context: { client: { clientName: string; visitorData: string } };
    };
    expect(body.videoId).toBe("aaaaaaaaaaa");
    expect(body.playlistId).toBe("RDAMVMaaaaaaaaaaa");
    expect(body.context.client).toMatchObject({ clientName: "WEB_REMIX", visitorData: "VD123" });
  });

  // YouTube Music is not CORS-enabled: a browser-level fetch from the Android /
  // iOS WebView is blocked before it leaves the page, which killed the radio
  // (and therefore autoplay) queue refill on mobile.
  it("never calls the browser fetch directly", async () => {
    const browserFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("CORS blocked in the WebView"));

    await postInnertube("search", { query: "the weeknd" });

    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("reports an unreachable YouTube Music as an Innertube error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await postInnertube("next", { videoId: "aaaaaaaaaaa" }).catch((err) => err);

    expect(error).toBeInstanceOf(InnertubeError);
    expect((error as InnertubeError).status).toBe(0);
    expect((error as Error).message).toMatch(/unreachable/);
  });

  it("keeps the HTTP status of a rejected request", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));

    await expect(postInnertube("next", { videoId: "aaaaaaaaaaa" })).rejects.toThrow(/HTTP 503/);
  });

  it("rejects an answer that is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));

    await expect(postInnertube("next", { videoId: "aaaaaaaaaaa" })).rejects.toThrow(/invalid JSON/);
  });

  it("propagates cancellation instead of reporting a network error", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(
      postInnertube("next", { videoId: "aaaaaaaaaaa" }, { signal: controller.signal }),
    ).rejects.toThrow(/Aborted/);
  });
});
