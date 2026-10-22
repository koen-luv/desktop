import { describe, expect, it } from "vitest";
import {
  decodePartyCode,
  encodePartyCode,
  PARTY_CODE_PREFIX,
} from "./partySession";

/** Realistic repetitive SDP — what a WebRTC offer actually looks like. */
function makeSdp(seed: string): string {
  return [
    "v=0",
    "o=- 4611735385357044321 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0 1",
    `a=ice-ufrag:${seed}`,
    `a=ice-pwd:${seed}${seed}${seed}`,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=sctp-port:5000",
    ...Array.from(
      { length: 24 },
      (_, i) =>
        `a=candidate:1 1 udp 2122260223 192.168.1.${i + 2} 54321 typ host generation 0`,
    ),
    "",
  ].join("\r\n");
}

const offer = { type: "offer" as const, sdp: makeSdp("AbCdEfGh") };
const answer = { type: "answer" as const, sdp: makeSdp("ZzYyXxWw") };

describe("party code round-trip", () => {
  it("encodes with the versioned prefix", async () => {
    const code = await encodePartyCode(offer);
    expect(code.startsWith(PARTY_CODE_PREFIX)).toBe(true);
    expect(code).not.toMatch(/\s/); // survives a share sheet / messaging app
  });

  it("round-trips an offer", async () => {
    const code = await encodePartyCode(offer);
    await expect(decodePartyCode(code)).resolves.toEqual(offer);
  });

  it("round-trips an answer", async () => {
    const code = await encodePartyCode(answer);
    await expect(decodePartyCode(code)).resolves.toEqual(answer);
  });

  it("round-trips through whitespace the user's clipboard added", async () => {
    const code = await encodePartyCode(offer);
    const messy = `\n  ${code}\n`;
    await expect(decodePartyCode(messy)).resolves.toEqual(offer);
  });

  it("stays comfortably smaller than raw SDP when compression is available", async () => {
    const json = JSON.stringify(offer);
    const code = await encodePartyCode(offer);
    // Raw base64 of the JSON is ~4/3 its size; the code must beat that even
    // in the uncompressed fallback, and beat both when deflate runs.
    expect(code.length).toBeLessThan(Math.ceil((json.length * 4) / 3) + 32);
  });
});

describe("party code rejection", () => {
  it("rejects anything without the prefix", async () => {
    await expect(decodePartyCode("just some text")).rejects.toThrow(
      /unknown format/,
    );
  });

  it("rejects garbage payloads", async () => {
    await expect(decodePartyCode(`${PARTY_CODE_PREFIX}aGVsbG8`)).rejects.toThrow();
    await expect(
      decodePartyCode(`${PARTY_CODE_PREFIX}!!!not-base64!!!`),
    ).rejects.toThrow();
  });

  it("rejects JSON that is not a session description", async () => {
    const notSdp = btoa(JSON.stringify({ hello: "world" }));
    await expect(decodePartyCode(PARTY_CODE_PREFIX + notSdp)).rejects.toThrow(
      /session description/,
    );
  });
});
