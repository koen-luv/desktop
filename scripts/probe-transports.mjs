// Check which playback transports the official API actually offers for a track.
import fs from "node:fs";
const acct = JSON.parse(fs.readFileSync(new URL("../android-test-account.json", import.meta.url), "utf8"));
const signerSrc = fs.readFileSync(new URL("../electron/signer.ts", import.meta.url), "utf8");
const b64 = /SIGNER_WASM_BASE64 = "([^"]+)"/.exec(signerSrc)[1];
const { instance } = await WebAssembly.instantiate(Buffer.from(b64, "base64"), {});
const wasm = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();
const pass = (s) => { const b = enc.encode(s); const p = wasm.liner_alloc(b.length); new Uint8Array(wasm.memory.buffer, p, b.length).set(b); return [p, b.length]; };
const sign = (method, path, body) => {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const m = pass(method), p = pass(path), b = pass(body ?? ""), n = pass(nonce);
  const code = wasm.liner_sign_request(m[0], m[1], p[0], p[1], b[0], b[1], BigInt(ts), n[0], n[1]);
  const ptr = wasm.liner_get_result_ptr(), len = wasm.liner_get_result_len();
  if (code !== 0) throw new Error("sign failed");
  return { "x-liner-signature": dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len)), "x-liner-timestamp": String(ts), "x-liner-nonce": nonce };
};
const loginBody = JSON.stringify({ email: acct.email, password: acct.password });
const auth = await (await fetch("https://api.tryliner.fun/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", ...sign("POST", "/v1/auth/login", loginBody) }, body: loginBody })).json();
const Bearer = `Bearer ${auth.accessToken}`;
const trackId = process.argv[2] || "0wTOi2TCSSk";
for (const opts of [
  {},
  { transport: "proxy" },
  { transport: "direct_innertube" },
  { preferredCodec: "aac" },
  { transport: "proxy", preferredCodec: "aac" },
]) {
  const body = JSON.stringify(opts);
  const path = `/v1/tracks/${trackId}/playback`;
  const res = await fetch("https://api.tryliner.fun" + path, { method: "POST", headers: { "content-type": "application/json", authorization: Bearer, ...sign("POST", path, body) }, body });
  const json = await res.json().catch(() => ({}));
  const summary = {
    status: res.status,
    transport: json.transport ?? json.code ?? null,
    hasStreamUrl: Boolean(json.streamUrl),
    streamHost: json.streamUrl ? new URL(json.streamUrl.startsWith("http") ? json.streamUrl : "https://x" + json.streamUrl).hostname : null,
    codec: json.codec ?? null,
    expiresAt: json.expiresAt ?? null,
    err: json.message ?? null,
  };
  console.log(JSON.stringify(opts), "->", JSON.stringify(summary));
}
