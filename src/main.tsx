import React from "react";
import ReactDOM from "react-dom/client";
import { initGlobalErrorHandlers } from "@/shared/utils/globalErrorHandlers";
import { installAndroidPlatform } from "@/platform";

// Install the native Android platform boundary before anything reads it
// (loadRoot's dynamic imports pull in modules that touch window.LinerAndroid).
installAndroidPlatform();

// Initialize global uncaught error handlers
initGlobalErrorHandlers();

const isOverlay = window.location.hash.startsWith("#/overlay");

async function loadRoot(): Promise<React.ReactElement> {
  if (isOverlay) {
    const { default: OverlayApp } = await import("./app/OverlayApp");
    return <OverlayApp />;
  }
  const [{ initMainWindowServices }, { default: App }, { default: RootErrorBoundary }] = await Promise.all([
    import("./app/mainWindowServices"),
    import("./app/App"),
    import("@/shared/ui/RootErrorBoundary"),
  ]);
  initMainWindowServices();
  return (
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  );
}

const rootElement = document.getElementById("root");

if (rootElement) {
  void loadRoot().then((root) => {
    ReactDOM.createRoot(rootElement).render(<React.StrictMode>{root}</React.StrictMode>);
  });
}
