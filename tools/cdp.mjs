#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol driver for the Android WebView. Used to
 * verify the running application in the emulator/device the same way a user
 * would: real DOM state, real bridge calls, real network, real playback.
 *
 * Usage:
 *   node tools/cdp.mjs "document.title"
 *   node tools/cdp.mjs --wait 2000 --logs "location.hash"
 *   node tools/cdp.mjs --screenshot /tmp/shot.png
 *   node tools/cdp.mjs --targets
 *
 * Env: CDP_PORT (default 9222), CDP_TARGET (index, default 0)
 */
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const port = process.env.CDP_PORT || "9222";
const targetIndex = Number(process.env.CDP_TARGET || "0");

function takeFlag(name, hasValue = false) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!hasValue) {
    args.splice(index, 1);
    return true;
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

const listTargets = takeFlag("--targets");
const screenshotPath = takeFlag("--screenshot", true);
const waitMs = Number(takeFlag("--wait", true) || "0");
const collectLogs = takeFlag("--logs");
const expression = args.join(" ").trim();

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

if (listTargets) {
  console.log(JSON.stringify(list.map((t, i) => ({ i, title: t.title, url: t.url })), null, 2));
  process.exit(0);
}

const target = list[targetIndex];
if (!target) {
  console.error(`No CDP target at index ${targetIndex} on port ${port}.`);
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const logs = [];

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (collectLogs && message.method === "Runtime.consoleAPICalled") {
    const text = (message.params.args || [])
      .map((a) => a.value ?? a.description ?? a.type)
      .join(" ");
    logs.push(`[console.${message.params.type}] ${text}`);
  }
  if (collectLogs && message.method === "Log.entryAdded") {
    logs.push(`[log.${message.params.entry.level}] ${message.params.entry.text}`);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");
await send("Log.enable").catch(() => {});

if (waitMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

if (expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    console.error("EVAL EXCEPTION:", JSON.stringify(result.exceptionDetails, null, 2));
  }
  console.log(JSON.stringify(result.result?.value ?? null, null, 2));
}

if (screenshotPath) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(screenshotPath, Buffer.from(shot.data, "base64"));
  console.log(`screenshot: ${screenshotPath}`);
}

if (collectLogs && logs.length > 0) {
  console.log("--- console/log ---");
  for (const line of logs) console.log(line);
}

ws.close();
