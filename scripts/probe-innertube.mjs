import fs from "node:fs";
const session = JSON.parse(fs.readFileSync(new URL("../android-test-account.json", import.meta.url), "utf8"));
// Reuse the full verifier by importing nothing: just perform login+session with a tiny signer helper.
const signerSrc = fs.readFileSync(new URL("../electron/signer.ts", import.meta.url), "utf8");
const b64 = /SIGNER_WASM_BASE64 = "([^"]+)"/.exec(signerSrc)?.[1];
const { instance } = await WebAssembly.instantiate(Buffer.from(b64, "base64"), {});
const wasm = instance.exports;
const enc = new TextEncoder();
const dec = new TextDecoder();
function pass(str) { const b = enc.encode(str); const ptr = wasm.liner_alloc(b.length); new Uint8Array(wasm.memory.buffer, ptr, b.length).set(b); return [ptr, b.length]; }
function sign(method, path, body) {
  const ts = Math.floor(Date.now() / 1000), nonce = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, "0")).join("");
  const m = pass(method), p = pass(path), b = pass(body ?? ""), n = pass(nonce);
  const code = wasm.liner_sign_request(m[0], m[1], p[0], p[1], b[0], b[1], BigInt(ts), n[0], n[1]);
  const ptr = wasm.liner_get_result_ptr(), len = wasm.liner_get_result_len();
  const sig = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
  return code === 0 ? { "x-liner-signature": sig, "x-liner-timestamp": String(ts), "x-liner-nonce": nonce } : null;
}
const body = JSON.stringify({ email: session.email, password: session.password });
const auth = await (await fetch("https://api.tryliner.fun/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", ...sign("POST", "/v1/auth/login", body) }, body })).json();
console.log("auth ok", !!auth.accessToken);
const trackId = process.argv[2] || "0wTOi2TCSSk";
const pbBody = JSON.stringify({});
const pb = await (await fetch(`https://api.tryliner.fun/v1/tracks/${trackId}/playback`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth.accessToken}`, ...sign("POST", `/v1/tracks/${trackId}/playback`, pbBody) }, body: pbBody })).json();
console.log("transport", pb.transport);
const vdRes = await fetch("https://www.youtube.com/sw.js_data", { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36" } });
const text = await vdRes.text();
const m = text.match(/Cgt[a-zA-Z0-9_-]{20,}={0,2}/);
console.log("visitorData", m ? m[0].slice(0, 28) + "..." : "none", "status", vdRes.status, "len", text.length);
const headers = { ...pb.headers };
if (m) headers["x-goog-visitor-id"] = m[0];
const reqBody = JSON.parse(JSON.stringify(pb.body));
if (m && reqBody.context?.client) reqBody.context.client.visitorData = m[0];
delete reqBody.context?.serviceIntegrityDimensions;
const res = await fetch(pb.endpoint, { method: pb.method || "POST", headers, body: JSON.stringify(reqBody) });
const data = await res.json();
console.log("playability", data.playabilityStatus?.status, data.playabilityStatus?.reason || "");
const formats = (data.streamingData?.adaptiveFormats || []).filter(f => f.mimeType?.includes("audio") && f.url);
console.log("formats", formats.length, formats.slice(0, 4).map(f => `${f.mimeType} ${f.bitrate}`));
if (formats.length) {
  const best = formats.find(f => f.mimeType.includes("webm")) || formats[0];
  const u = new URL(best.url);
  console.log("host", u.hostname, "expire", u.searchParams.get("expire"));
  const ar = await fetch(best.url, { headers: { Range: "bytes=0-65535" } });
  console.log("audio fetch", ar.status, ar.headers.get("content-type"), (await ar.arrayBuffer()).byteLength);
}
