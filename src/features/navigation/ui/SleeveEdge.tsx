import { memo } from "react";
import { usePlayerStore } from "@/features/player";

/**
 * The sleeve edge: the current cover art rendered as a 3px strip along the
 * layout boundary that already exists (desktop: inner edge of the nav spine;
 * mobile: top edge of the dock). It is the app's one signature element, and it
 * carries state rather than decoration — solid while playing, dimmed while
 * paused, absent when there is nothing in the player.
 */
interface SleeveEdgeProps {
  orientation?: "vertical" | "horizontal";
  className?: string;
}

function SleeveEdge({ orientation = "vertical", className = "" }: SleeveEdgeProps) {
  const coverUrl = usePlayerStore((state) => state.currentTrack?.coverUrl ?? null);
  const status = usePlayerStore((state) => state.status);
  const hasTrack = usePlayerStore((state) => Boolean(state.currentTrack));

  const active = hasTrack && status !== "idle";
  const playing = status === "playing" || status === "loading";

  const isVertical = orientation === "vertical";
  return (
    <div
      aria-hidden="true"
      className={`sleeve-edge pointer-events-none shrink-0 overflow-hidden transition-opacity duration-300 ${
        isVertical ? "w-[3px] self-stretch" : "h-[3px] w-full"
      } ${className}`}
      style={{
        opacity: !active ? 0 : playing ? 1 : 0.4,
        backgroundColor: active ? undefined : "transparent",
        backgroundImage: coverUrl ? `url("${coverUrl}")` : undefined,
        // Sample a thin slice of the artwork instead of squashing the whole
        // cover into the strip.
        backgroundSize: isVertical ? "cover" : "auto 300%",
        backgroundPosition: isVertical ? "left center" : "center top",
        backgroundRepeat: "no-repeat",
      }}
    >
      {active && !coverUrl ? (
        <div
          className={`h-full w-full ${isVertical ? "" : ""}`}
          style={{ backgroundColor: "var(--accent-primary)" }}
        />
      ) : null}
    </div>
  );
}

export default memo(SleeveEdge);
