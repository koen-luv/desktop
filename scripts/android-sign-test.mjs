// Diagnostic: verify the production WASM signer and official API contract from this machine.
import fs from "node:fs";
import crypto from "node:crypto";

const src = fs.readFileSync(new URL("../electron/signer.ts", import.meta.url), "utf8");
const b64 = /SIGNER_WASM_BASE64 = "([^"]+)"/.exec(src)?.[1];
if (!b64) throw new Error("signer wasm not found");
const bytes = Buffer.from(b64, "base64");
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports;

const enc = new TextEncoder();
const dec = new TextDecoder();
function pass(str) {
  const b = enc.encode(str);
  const ptr = wasm.liner_alloc(b.length);
  new Uint8Array(wasm.memory.buffer, ptr, b.length).set(b);
  return { ptr, len: b.length };
}
function result() {
  const ptr = wasm.liner_get_result_ptr();
  const len = wasm.liner_get_result_len();
  return dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
}
function sign(method, path, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString("hex");
  const m = pass(method), p = pass(path), b = pass(body ?? ""), n = pass(nonce);
  const code = wasm.liner_sign_request(m.ptr, m.len, p.ptr, p.len, b.ptr, b.len, BigInt(timestamp), n.ptr, n.len);
  if (code !== 0) throw new Error("sign failed " + code);
  const sig = result();
  wasm.liner_dealloc(m.ptr, m.len);
  wasm.liner_dealloc(p.ptr, p.len);
  wasm.liner_dealloc(b.ptr, b.len);
  wasm.liner_dealloc(n.ptr, n.len);
  return { signature: sig, timestamp, nonce };
}

const body = JSON.stringify({ email: "android-port-probe@invalid.example", password: "not-a-real-password" });
const signed = sign("POST", "/v1/auth/login", body);
const res = await fetch("https://api.tryliner.fun/v1/auth/login", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-liner-signature": signed.signature,
    "x-liner-timestamp": String(signed.timestamp),
    "x-liner-nonce": signed.nonce,
    "x-client-version": "1.0.4-desktop",
    "x-platform": "android",
  },
  body,
});
console.log("login status:", res.status);
console.log("login body:", await res.text());
console.log("cover url signer export present:", typeof wasm.liner_sign_cover_url === "function");
console.log("signed cover sample:", wasm.liner_sign_cover_url(pass("test").ptr, 4), "(ptr result not read)");
