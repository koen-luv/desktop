import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  const calls: { file: string; args: string[] }[] = [];
  const state = {
    userData: "",
    stdout: "",
    error: null as Error | null,
    calls,
    execFile: (
      file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      calls.push({ file, args });
      if (args[0] === "--version") {
        callback(null, "");
        return;
      }
      callback(state.error, state.stdout);
    },
  };
  return state;
});

vi.mock("electron", () => ({
  app: { getPath: () => mock.userData },
  ipcMain: { handle: () => {} },
}));

vi.mock("node:child_process", () => ({
  execFile: mock.execFile,
  default: { execFile: mock.execFile },
}));

import { resolveYtDlp, toYtDlpStream } from "./ytdlp";

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "neritium-ytdlp-"));
  fs.mkdirSync(path.join(userData, "bin"));
  fs.writeFileSync(
    path.join(userData, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"),
    "",
  );
  mock.userData = userData;
  mock.stdout = "";
  mock.error = null;
  mock.calls.length = 0;
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("toYtDlpStream", () => {
  it("maps a yt-dlp record to the player stream shape", () => {
    const stream = toYtDlpStream({
      url: "https://rr1.googlevideo.com/videoplayback?expire=1700000000&mime=audio%2Fwebm",
      ext: "webm",
      acodec: "opus",
      abr: 128.5,
    });
    expect(stream).toEqual({
      url: "https://rr1.googlevideo.com/videoplayback?expire=1700000000&mime=audio%2Fwebm",
      mimeType: "audio/webm",
      codec: "opus",
      bitrate: 128_500,
      expiresAtMs: 1_700_000_000_000,
    });
  });

  it("falls back to the URL's mime type and skips unknown expiry", () => {
    const stream = toYtDlpStream({
      url: "https://media.example/audio?mime=audio%2Fmp4",
      acodec: "mp4a.40.2",
    });
    expect(stream?.mimeType).toBe("audio/mp4");
    expect(stream?.codec).toBe("aac");
    expect(stream?.expiresAtMs).toBeNull();
    expect(stream?.bitrate).toBeUndefined();
  });

  it("rejects a record without a playable URL", () => {
    expect(toYtDlpStream({ ext: "webm", acodec: "opus" })).toBeNull();
  });
});

describe("resolveYtDlp", () => {
  it("returns the parsed stream from yt-dlp JSON output", async () => {
    mock.stdout = `${JSON.stringify({
      url: "https://rr1.googlevideo.com/videoplayback?expire=1700000000",
      ext: "m4a",
      acodec: "mp4a.40.2",
      abr: 129,
    })}\n`;

    const result = await resolveYtDlp("dQw4w9WgXcQ");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stream.mimeType).toBe("audio/mp4");
    expect(result.stream.codec).toBe("aac");
    expect(result.stream.url).toContain("videoplayback");

    const resolveCall = mock.calls.at(-1);
    expect(resolveCall?.args).toContain("-j");
    expect(resolveCall?.args).toContain("bestaudio/best");
    expect(resolveCall?.args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("reports failure when yt-dlp exits with an error", async () => {
    mock.error = new Error("signature extraction failed");

    const result = await resolveYtDlp("dQw4w9WgXcQ");

    expect(result).toEqual({ ok: false, error: "yt-dlp failed: signature extraction failed" });
  });
});
