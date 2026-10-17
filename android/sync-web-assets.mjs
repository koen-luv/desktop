#!/usr/bin/env node
/**
 * Copies the production renderer bundle (dist/) into the Android app assets so
 * the release APK ships the real application instead of depending on a dev
 * server. Run `pnpm build` first (or use `pnpm android:apk`).
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const distDir = path.join(projectRoot, "dist");
const targetDir = path.join(here, "app", "src", "main", "assets");

if (!existsSync(path.join(distDir, "index.html"))) {
  console.error("dist/index.html not found. Run `pnpm build` before syncing web assets.");
  process.exit(1);
}

// The WebViewAssetLoader maps "/" to the assets root, and the bundle registers
// "/cover-sw.js" at the domain root, so every file is copied to the root.
for (const entry of ["index.html", "cover-sw.js", "icon.png", "assets"]) {
  await rm(path.join(targetDir, entry), { recursive: true, force: true });
}
await mkdir(targetDir, { recursive: true });
await cp(distDir, targetDir, { recursive: true });

const entries = await readdir(targetDir);
let bytes = 0;
async function measure(dir) {
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) await measure(full);
    else bytes += info.size;
  }
}
await measure(targetDir);

console.log(
  `Synced web bundle to android assets ` +
    `(${(bytes / 1024 / 1024).toFixed(1)} MB, ${entries.length} top-level entries).`,
);
