/**
 * Android in-process signer.
 *
 * Desktop signs requests in the Electron main process over IPC. Android has no
 * Electron main process, so the exact same production WASM signer binary that
 * ships with the desktop build is instantiated directly inside the WebView.
 * The algorithm, canonical string, key derivation and clock synchronisation are
 * unchanged; only the transport (IPC vs in-process) differs.
 */
import { SIGNER_WASM_BASE64 } from "../../electron/signer";

export interface SignRequestInput {
  method: string;
  path: string;
  body?: string | null;
  timestamp?: number;
}

export interface SignedRequestHeaders {
  signature: string;
  timestamp: number;
  nonce: string;
}

interface WasmSignerExports {
  liner_alloc: (len: number) => number;
  liner_dealloc: (ptr: number, len: number) => void;
  liner_get_result_ptr: () => number;
  liner_get_result_len: () => number;
  liner_sign_cover_url: (ptr: number, len: number) => number;
  liner_sign_request: (
    methodPtr: number,
    methodLen: number,
    pathPtr: number,
    pathLen: number,
    bodyPtr: number,
    bodyLen: number,
    timestamp: bigint,
    noncePtr: number,
    nonceLen: number,
  ) => number;
  liner_sign_monitor_request: (
    methodPtr: number,
    methodLen: number,
    pathPtr: number,
    pathLen: number,
    bodyPtr: number,
    bodyLen: number,
    timestamp: bigint,
    noncePtr: number,
    nonceLen: number,
  ) => number;
  liner_sign_raw_payload: (ptr: number, len: number) => number;
  memory: WebAssembly.Memory;
}

let wasm: WasmSignerExports | null = null;
let serverTimeOffsetMs = 0;

function getWasm(): WasmSignerExports {
  if (wasm) return wasm;
  const binary = Uint8Array.from(atob(SIGNER_WASM_BASE64), (c) => c.charCodeAt(0));
  const module = new WebAssembly.Module(binary);
  const instance = new WebAssembly.Instance(module, {});
  wasm = instance.exports as unknown as WasmSignerExports;
  return wasm;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function passString(exports: WasmSignerExports, value: string) {
  const bytes = encoder.encode(value);
  const ptr = exports.liner_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
  return { ptr, len: bytes.length, free: () => exports.liner_dealloc(ptr, bytes.length) };
}

function readResult(exports: WasmSignerExports): string {
  const ptr = exports.liner_get_result_ptr();
  const len = exports.liner_get_result_len();
  if (!ptr || len === 0) return "";
  return decoder.decode(new Uint8Array(exports.memory.buffer, ptr, len));
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function syncServerTime(dateHeaderOrMs: string | number | Date): number {
  const serverMs =
    typeof dateHeaderOrMs === "number"
      ? dateHeaderOrMs
      : typeof dateHeaderOrMs === "string"
        ? Date.parse(dateHeaderOrMs)
        : dateHeaderOrMs.getTime();
  if (!Number.isNaN(serverMs) && serverMs > 0) {
    serverTimeOffsetMs = serverMs - Date.now();
  }
  return serverTimeOffsetMs;
}

export function getServerTimeOffset(): number {
  return serverTimeOffsetMs;
}

function adjustedTimestamp(): number {
  return Math.floor((Date.now() + serverTimeOffsetMs) / 1000);
}

function signWith(
  fn: WasmSignerExports["liner_sign_request"],
  input: SignRequestInput,
): SignedRequestHeaders {
  const exports = getWasm();
  const timestamp = input.timestamp ?? adjustedTimestamp();
  const nonce = randomNonce();
  const method = passString(exports, input.method.toUpperCase().trim());
  const path = passString(exports, input.path);
  const body = passString(exports, input.body ?? "");
  const nonceBuf = passString(exports, nonce);
  try {
    const code = fn.call(
      exports,
      method.ptr,
      method.len,
      path.ptr,
      path.len,
      body.ptr,
      body.len,
      BigInt(timestamp),
      nonceBuf.ptr,
      nonceBuf.len,
    );
    if (code !== 0) throw new Error(`wasm signer failed with code ${code}`);
    return { signature: readResult(exports), timestamp, nonce };
  } finally {
    method.free();
    path.free();
    body.free();
    nonceBuf.free();
  }
}

export function signRequest(input: SignRequestInput): SignedRequestHeaders {
  return signWith(getWasm().liner_sign_request, input);
}

export function signMonitorRequest(input: SignRequestInput): SignedRequestHeaders {
  return signWith(getWasm().liner_sign_monitor_request, input);
}

export function signCoverUrl(payload: string): string {
  const exports = getWasm();
  const buf = passString(exports, payload);
  try {
    const code = exports.liner_sign_cover_url(buf.ptr, buf.len);
    if (code !== 0) throw new Error(`wasm cover signer failed with code ${code}`);
    return readResult(exports);
  } finally {
    buf.free();
  }
}

export function signRawPayload(payload: Uint8Array): string {
  const exports = getWasm();
  const ptr = exports.liner_alloc(payload.length);
  new Uint8Array(exports.memory.buffer, ptr, payload.length).set(payload);
  try {
    const code = exports.liner_sign_raw_payload(ptr, payload.length);
    if (code !== 0) throw new Error(`wasm raw signer failed with code ${code}`);
    return readResult(exports);
  } finally {
    exports.liner_dealloc(ptr, payload.length);
  }
}
