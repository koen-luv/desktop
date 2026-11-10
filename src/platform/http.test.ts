import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platformFetch } from "./http";
import { installAndroidPlatform } from "./index";

vi.mock("@/shared/api/baseUrl", () => ({
  getApiBaseUrl: () => "https://liner-api.lucabatarcian.workers.dev",
}));

interface TestWindow {
  NeritiumAndroid?: unknown;
  neritiumElectron?: unknown;
  __neritiumAndroidEmit?: (type: string, payload: string) => void;
}

const win = window as unknown as TestWindow;

describe("platformFetch", () => {
  let httpRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    httpRequest = vi.fn(
      (id: string, _method: string, _url: string, _headersJson: string, _body: string | null) => {
        setTimeout(() => {
          win.__neritiumAndroidEmit?.(
            "httpResponse",
            JSON.stringify({
              id,
              status: 200,
              ok: true,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ok: true }),
            }),
          );
        }, 0);
      },
    );
    win.NeritiumAndroid = {
      getInsets: () => "{}",
      setLightSystemBars: () => {},
      httpRequest,
    };
    installAndroidPlatform();
  });

  afterEach(() => {
    delete win.NeritiumAndroid;
    delete win.neritiumElectron;
    delete win.__neritiumAndroidEmit;
    vi.restoreAllMocks();
  });

  // YouTube Music sends no CORS headers, so on Android/iOS the Innertube
  // requests (radio queue, search, player) must leave through the native
  // bridge instead of the WebView's fetch.
  it("sends YouTube Music POSTs through the native bridge", async () => {
    const browserFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("browser fetch must not be used"));

    const response = await platformFetch(
      "https://music.youtube.com/youtubei/v1/next?prettyPrint=false",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );

    expect(httpRequest).toHaveBeenCalledTimes(1);
    const [id, method, url] = httpRequest.mock.calls[0] as [string, string, string];
    expect(typeof id).toBe("string");
    expect(method).toBe("POST");
    expect(url).toBe("https://music.youtube.com/youtubei/v1/next?prettyPrint=false");
    expect(browserFetch).not.toHaveBeenCalled();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("sends self-hosted Worker POSTs through the native bridge", async () => {
    const browserFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("browser fetch must not be used"));

    const body = JSON.stringify({ email: "a@b.co", password: "password123" });
    const response = await platformFetch(
      "https://liner-api.lucabatarcian.workers.dev/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );

    expect(httpRequest).toHaveBeenCalledTimes(1);
    const [id, method, url, , sentBody] = httpRequest.mock.calls[0] as [
      string,
      string,
      string,
      string,
      string | null,
    ];
    expect(typeof id).toBe("string");
    expect(method).toBe("POST");
    expect(url).toBe("https://liner-api.lucabatarcian.workers.dev/v1/auth/login");
    expect(sentBody).toBe(body);
    expect(browserFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("uses the browser fetch when no native bridge is installed", async () => {
    delete win.NeritiumAndroid;
    const browserFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await platformFetch("https://music.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      body: "{}",
    });

    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("keeps API GETs in the browser, where the WebView proxies them", async () => {
    const browserFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await platformFetch("https://api.tryliner.fun/v1/me", { method: "GET" });

    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
