import { initTelemetry } from "@/shared/telemetry";
import { initBackgroundStorageAnalytics } from "@/shared/utils/cacheManager";
import { initClientVisitorSession } from "@/shared/api/visitorSession";
import { initBundleStampLog } from "@/shared/utils/bundleStampLog";
import { isWebApp } from "@/platform";

export function initMainWindowServices() {
  initTelemetry();
  initBackgroundStorageAnalytics();
  // The visitor session is fetched straight from youtube.com, which a browser
  // cannot read (CORS). Warming it on the website only produces a failed
  // request on every boot; the Innertube fallback warms it lazily if playback
  // ever needs it, and the API-resolved stream path does not need it at all.
  if (!isWebApp()) {
    initClientVisitorSession();
  }
  initBundleStampLog();
}
