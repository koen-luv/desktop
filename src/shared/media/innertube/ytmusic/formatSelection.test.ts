import { describe, expect, it } from "vitest";
import { selectBestYtAudioFormat, type YtAudioFormat } from "./formatSelection";

const opus: YtAudioFormat = {
  itag: 251,
  url: "https://rr1.googlevideo.com/videoplayback?itag=251",
  mimeType: 'audio/webm; codecs="opus"',
  bitrate: 135_000,
  audioChannels: 2,
  audioSampleRate: 48_000,
};
const aac: YtAudioFormat = {
  itag: 140,
  url: "https://rr1.googlevideo.com/videoplayback?itag=140",
  mimeType: 'audio/mp4; codecs="mp4a.40.2"',
  bitrate: 130_000,
  audioChannels: 2,
  audioSampleRate: 44_100,
};
const low: YtAudioFormat = {
  itag: 249,
  url: "https://rr1.googlevideo.com/videoplayback?itag=249",
  mimeType: 'audio/webm; codecs="opus"',
  bitrate: 50_000,
  audioChannels: 1,
};
const ciphered: YtAudioFormat = {
  itag: 251,
  signatureCipher: "s=ABC&sp=sig&url=https%3A%2F%2Frr1.googlevideo.com%2Fvideoplayback%3Fitag%3D251",
  mimeType: 'audio/webm; codecs="opus"',
  bitrate: 135_000,
};

function xtags(content: string): string {
  // Hand-rolled protobuf map: entry {1: "acont", 2: content} repeated.
  const entry = [0x0a, 0x05, ...[..."acont"].map((c) => c.charCodeAt(0)), 0x12, content.length, ...[...content].map((c) => c.charCodeAt(0))];
  const bytes = Uint8Array.from([0x0a, entry.length, ...entry]);
  return Buffer.from(bytes).toString("base64url");
}

describe("selectBestYtAudioFormat", () => {
  it("prefers opus 251 for the standard tier and honors aac preference", () => {
    expect(selectBestYtAudioFormat([low, aac, opus])?.itag).toBe(251);
    expect(selectBestYtAudioFormat([low, aac], { preferredCodec: "aac" })?.itag).toBe(140);
    expect(selectBestYtAudioFormat([low, aac], { preferredCodec: "opus" })?.itag).toBe(249);
  });

  it("takes the smallest mp4 for the low tier", () => {
    const tiny: YtAudioFormat = { ...aac, itag: 139, bitrate: 48_000 };
    expect(selectBestYtAudioFormat([opus, aac, tiny], { quality: "low" })?.itag).toBe(139);
  });

  it("takes the objectively best format for the high tier", () => {
    const hiFi: YtAudioFormat = { ...aac, itag: 141, bitrate: 256_000 };
    expect(selectBestYtAudioFormat([opus, aac, hiFi], { quality: "high" })?.itag).toBe(141);
  });

  it("never lets a dubbed track outrank the original", () => {
    const dub: YtAudioFormat = { ...opus, itag: 251, bitrate: 300_000, xtags: xtags("dubbed") };
    const original: YtAudioFormat = { ...aac, itag: 140, xtags: xtags("original") };
    expect(selectBestYtAudioFormat([dub, original])?.itag).toBe(140);
  });

  it("accepts decipherable formats but rejects unresolvable ones", () => {
    expect(selectBestYtAudioFormat([ciphered])?.itag).toBe(251);
    const broken: YtAudioFormat = { itag: 999, mimeType: "audio/mp4", bitrate: 999_000 };
    expect(selectBestYtAudioFormat([broken])).toBeNull();
  });

  it("ignores video formats and empty input", () => {
    const video = { itag: 18, url: "https://x", mimeType: "video/mp4", bitrate: 500_000 };
    expect(selectBestYtAudioFormat([video as unknown as YtAudioFormat])).toBeNull();
    expect(selectBestYtAudioFormat([])).toBeNull();
  });
});
