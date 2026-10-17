// End-to-end verification of the official Liner API using the production WASM signer.
import fs from "node:fs";
import crypto from "node:crypto";

const repoRoot = new URL("..", import.meta.url);
const signerSrc = fs.readFileSync(new URL("../electron/signer.ts", import.meta.url), "utf8");
const b64 = /SIGNER_WASM_BASE64 = "([^"]+)"/.exec(signerSrc)?.[1];
if (!b64) throw new Error("signer wasm not found");
const { instance } = await WebAssembly.instantiate(Buffer.from(b64, "base64"), {});
const wasm = instance.exports;
const enc = new TextEncoder();
const dec = new TextDecoder();

let serverOffsetMs = 0;
function adjustTs() {
  return Math.floor((Date.now() + serverOffsetMs) / 1000);
}
function pass(str) {
  const b = enc.encode(str);
  const ptr = wasm.liner_alloc(b.length);
  new Uint8Array(wasm.memory.buffer, ptr, b.length).set(b);
  return { ptr, len: b.length };
}
function readResult() {
  const ptr = wasm.liner_get_result_ptr();
  const len = wasm.liner_get_result_len();
  return dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
}
function sign(method, path, body) {
  const timestamp = adjustTs();
  const nonce = crypto.randomBytes(8).toString("hex");
  const m = pass(method), p = pass(path), b = pass(body ?? ""), n = pass(nonce);
  const code = wasm.liner_sign_request(m.ptr, m.len, p.ptr, p.len, b.ptr, b.len, BigInt(timestamp), n.ptr, n.len);
  if (code !== 0) throw new Error("sign failed " + code);
  const signature = readResult();
  for (const [x, l] of [[m.ptr, m.len], [p.ptr, p.len], [b.ptr, b.len], [n.ptr, n.len]]) wasm.liner_dealloc(x, l);
  return { "x-liner-signature": signature, "x-liner-timestamp": String(timestamp), "x-liner-nonce": nonce };
}

let session = null;
async function request(method, path, body) {
  const signed = sign(method, path.split("?")[0], body);
  const headers = {
    ...signed,
    "x-client-version": "1.0.4-desktop",
    "x-platform": "android",
    ...(body ? { "content-type": "application/json" } : {}),
    ...(session?.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}),
  };
  const res = await fetch("https://api.tryliner.fun" + path, { method, headers, body });
  const date = res.headers.get("date");
  if (date) serverOffsetMs = Date.parse(date) - Date.now();
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

const accountPath = new URL("../android-test-account.json", import.meta.url);
let account;
let registered = false;
if (fs.existsSync(accountPath)) {
  account = JSON.parse(fs.readFileSync(accountPath, "utf8"));
} else {
  const suffix = crypto.randomBytes(4).toString("hex");
  account = {
    email: `liner.android.port.${suffix}@example.com`,
    password: `Liner-${crypto.randomBytes(9).toString("base64url")}!`,
    username: `liner_android_${suffix}`,
    displayName: "Liner Android QA",
  };
  fs.writeFileSync(accountPath, JSON.stringify(account, null, 2));
}

try {
  session = await request("POST", "/v1/auth/login", JSON.stringify({ email: account.email, password: account.password }));
  console.log("login: existing test account ok");
} catch (err) {
  if (!String(err.message).includes("INVALID_CREDENTIALS")) throw err;
  session = await request("POST", "/v1/auth/register", JSON.stringify({
    email: account.email, password: account.password, username: account.username, displayName: account.displayName,
  }));
  registered = true;
  console.log("login: registered fresh test account", registered);
}
console.log("user:", session.user?.username, session.user?.id);
console.log("access token expiresAt:", session.accessTokenExpiresAt ?? session.expiresAt);

const search = await request("GET", "/v1/search?q=daft%20punk&type=track");
const tracks = search.results ?? search.items ?? search.tracks ?? search;
const trackList = Array.isArray(tracks) ? tracks : (tracks.tracks ?? []);
console.log("search results:", trackList.length, "first:", trackList[0]?.title, trackList[0]?.id);
if (!trackList.length) throw new Error("no search results");

const track = trackList[0];
const details = await request("GET", `/v1/tracks/${encodeURIComponent(track.id)}`);
console.log("track details:", details.title, "duration_ms:", details.duration_ms ?? details.durationMs);

const playback = await request("POST", `/v1/tracks/${encodeURIComponent(track.id)}/playback`, JSON.stringify({}));
console.log("playback transport:", playback.transport, "mime:", playback.mimeType, "expires:", playback.expiresAt);
let streamUrl = playback.streamUrl;
let mime = playback.mimeType;
if (playback.transport === "direct_innertube") {
  const headers = { ...(playback.headers ?? {}) };
  const body = JSON.parse(JSON.stringify(playback.body));
  const res = await fetch(playback.endpoint, { method: playback.method || "POST", headers, body: JSON.stringify(body) });
  console.log("innertube status:", res.status);
  if (!res.ok) throw new Error(`innertube ${res.status}`);
  const data = await res.json();
  console.log("playability:", data.playabilityStatus?.status, data.playabilityStatus?.reason ?? "");
  const formats = (data.streamingData?.adaptiveFormats ?? []).filter((f) => f.mimeType?.includes("audio") && f.url);
  console.log("audio formats:", formats.length, formats.slice(0, 3).map((f) => `${f.mimeType} ${f.bitrate}`));
  const best = formats.find((f) => f.mimeType.includes("webm")) ?? formats[0];
  streamUrl = best?.url;
  mime = best?.mimeType;
}
if (streamUrl) {
  const res = await fetch(streamUrl, { headers: { Range: "bytes=0-131071" } });
  console.log("stream fetch:", res.status, res.headers.get("content-type"), res.headers.get("content-length"));
  const buf = new Uint8Array(await res.arrayBuffer());
  console.log("stream head:", Array.from(buf.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" "), "bytes:", buf.length);
  fs.writeFileSync(new URL("../android-stream-sample.bin", import.meta.url), buf);
} else {
  throw new Error("no stream url");
}
console.log("ACCOUNT_FILE:", accountPath.pathname);
console.log("ACCOUNT_EMAIL:", account.email);
if (registered) console.log("ACCOUNT_PASSWORD:", account.password);
