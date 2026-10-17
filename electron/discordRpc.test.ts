import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrames, discordIpcCandidates } from "./discordRpc";

describe("Discord IPC framing", () => {
  it("round-trips a single frame", () => {
    const payload = { v: 1, client_id: "123" };
    const { frames, rest } = decodeFrames(encodeFrame(0, payload));
    expect(frames).toHaveLength(1);
    expect(frames[0].opcode).toBe(0);
    expect(JSON.parse(frames[0].payload.toString("utf8"))).toEqual(payload);
    expect(rest.length).toBe(0);
  });

  it("writes a little-endian opcode + length header", () => {
    const frame = encodeFrame(1, { a: 1 });
    expect(frame.readUInt32LE(0)).toBe(1);
    expect(frame.readUInt32LE(4)).toBe(frame.length - 8);
  });

  it("decodes multiple frames buffered together", () => {
    const buf = Buffer.concat([
      encodeFrame(1, { cmd: "SET_ACTIVITY" }),
      encodeFrame(1, { evt: "READY" }),
    ]);
    const { frames } = decodeFrames(buf);
    expect(frames).toHaveLength(2);
    expect(JSON.parse(frames[0].payload.toString("utf8"))).toEqual({ cmd: "SET_ACTIVITY" });
    expect(JSON.parse(frames[1].payload.toString("utf8"))).toEqual({ evt: "READY" });
  });

  it("holds back an incomplete frame until the remaining bytes arrive", () => {
    const full = encodeFrame(1, { hello: "world" });
    const partial = full.subarray(0, full.length - 3);

    const first = decodeFrames(partial);
    expect(first.frames).toHaveLength(0);
    expect(first.rest.length).toBe(partial.length);

    const merged = Buffer.concat([first.rest, full.subarray(full.length - 3)]);
    const second = decodeFrames(merged);
    expect(second.frames).toHaveLength(1);
    expect(JSON.parse(second.frames[0].payload.toString("utf8"))).toEqual({ hello: "world" });
  });
});

describe("discordIpcCandidates", () => {
  it("uses named pipes on Windows", () => {
    const candidates = discordIpcCandidates("win32");
    expect(candidates).toHaveLength(10);
    expect(candidates[0]).toBe("\\\\.\\pipe\\discord-ipc-0");
  });

  it("uses unix sockets (not pipes) on linux", () => {
    const candidates = discordIpcCandidates("linux");
    expect(candidates.some((p) => p.includes("discord-ipc-0"))).toBe(true);
    expect(candidates.every((p) => !p.startsWith("\\\\.\\pipe"))).toBe(true);
  });
});
