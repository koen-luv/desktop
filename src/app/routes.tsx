import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import HomePage from "@/features/home/ui/HomePage";

// The landing page stays in the first chunk; every other route is split out.
// The shell loads the bundle from disk, so this buys parse/execute time before
// the window is first usable rather than network time.
const LibraryPage = lazy(() => import("@/features/library/ui/LibraryPage"));
const PlaylistPage = lazy(() => import("@/features/library/ui/PlaylistPage"));
const ArtistPage = lazy(() => import("@/features/artist/ui/ArtistPage"));
const CollectionPage = lazy(() => import("@/features/collection/ui/CollectionPage"));
const LoginPage = lazy(() => import("@/features/auth/ui/LoginPage"));
const PlayerPage = lazy(() => import("@/features/player/ui/FullscreenPlayer"));

const ROUTE_LOADERS: Array<() => Promise<unknown>> = [
  () => import("@/features/library/ui/LibraryPage"),
  () => import("@/features/library/ui/PlaylistPage"),
  () => import("@/features/artist/ui/ArtistPage"),
  () => import("@/features/collection/ui/CollectionPage"),
  () => import("@/features/auth/ui/LoginPage"),
  () => import("@/features/player/ui/FullscreenPlayer"),
];

let prefetchStarted = false;

/**
 * Pull the split routes in once the window is idle, so deferring them costs
 * nothing the first time a page is opened.
 */
export function prefetchRoutes(): void {
  if (prefetchStarted) return;
  prefetchStarted = true;

  const run = () => {
    for (const load of ROUTE_LOADERS) void load().catch(() => {});
  };

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 1500);
  }
}

export function AppRoutes() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/library/playlist" element={<PlaylistPage />} />
        <Route path="/artist" element={<ArtistPage />} />
        <Route path="/collection" element={<CollectionPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/settings" element={<Navigate to="/" replace />} />
        <Route path="/player" element={<PlayerPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
