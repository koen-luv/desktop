import { isAndroidApp } from "@/platform";
import { PlayerRuntime, playerRuntime as desktopRuntime } from "./playerRuntime";
import { AndroidPlayerRuntime } from "./androidPlayerRuntime";

/**
 * Single playback runtime for the whole renderer. Desktop keeps the existing
 * HTMLAudioElement + Web Audio engine; Android uses the native Media3 service.
 * The desktop singleton is imported instead of constructed so there is exactly
 * one audio engine per page.
 */
export const playerRuntime =
  typeof window !== "undefined"
    ? isAndroidApp()
      ? new AndroidPlayerRuntime()
      : desktopRuntime
    : null;

export type PlayerRuntimeSurface = PlayerRuntime | AndroidPlayerRuntime;
