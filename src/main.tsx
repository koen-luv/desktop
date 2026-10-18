import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { RootErrorBoundary } from "@/shared/ui";
import { initGlobalErrorHandlers } from "@/shared/utils/globalErrorHandlers";
import { initTelemetry } from "@/shared/telemetry";
import { initBackgroundStorageAnalytics } from "@/shared/utils/cacheManager";
import { initClientVisitorSession } from "@/shared/api/visitorSession";
import { initBundleStampLog } from "@/shared/utils/bundleStampLog";

// Initialize global uncaught error, telemetry listeners, background storage tracker and visitor session
initGlobalErrorHandlers();
initTelemetry();
initBackgroundStorageAnalytics();
initClientVisitorSession();
initBundleStampLog();

const rootElement = document.getElementById("root");

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>,
  );
}

