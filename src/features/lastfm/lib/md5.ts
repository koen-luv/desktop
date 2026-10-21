/**
 * Minimal RFC 1321 MD5 (hex output) — used to sign Last.fm API requests,
 * which require `api_sig = md5(sorted(name+value) params + shared secret)`.
 * MD5 has no WebCrypto digest (delisted), so it is implemented inline.
 * Unicode input is encoded as UTF-8 before hashing, as the API expects.
 */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);

  // Per-round left-rotation amounts (RFC 1321, section 3.4).
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  // K[i] = floor(abs(sin(i + 1)) * 2^32) — the RFC's sine-derived table.
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  }

  // Pad: 0x80, zeros, then the 64-bit little-endian bit length. The strings
  // signed here are tiny, so the high word stays well within 32 bits.
  const bitLen = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLen >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      m[i] = view.getUint32(offset + i * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rol32((a + f + k[i] + m[g]) >>> 0, s[i])) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  // The digest is the four state words serialized little-endian (LSB first).
  return [a0, b0, c0, d0]
    .map((word) =>
      [0, 1, 2, 3]
        .map((byte) => ((word >>> (byte * 8)) & 0xff).toString(16).padStart(2, "0"))
        .join(""),
    )
    .join("");
}

function rol32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}
