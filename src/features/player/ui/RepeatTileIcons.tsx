import { useId } from "react";

// "on" states for the repeat button, drawn to match Solar's Shuffle Bold: a filled
// squircle with the glyph knocked out of it. Solar's own Repeat Bold is just a
// heavier outline, so it never read as "on" next to the shuffle tile.

// same squircle outline Solar uses for its Bold tile icons (Shuffle Bold)
const TILE =
  "M12 22C7.28595 22 4.92893 22 3.46447 20.5355C2 19.0711 2 16.714 2 12C2 7.28595 2 4.92893 3.46447 3.46447C4.92893 2 7.28595 2 12 2C16.714 2 19.0711 2 20.5355 3.46447C22 4.92893 22 7.28595 22 12C22 16.714 22 19.0711 20.5355 20.5355C19.0711 22 16.714 22 12 22Z";

// loop with two arrowheads, sized to the same inner box the shuffle arrows use
const LOOP = [
  "M6.25 13V11.25A3 3 0 0 1 9.25 8.25H17.25",
  "M15.5 6.5L17.25 8.25L15.5 10",
  "M17.75 11V12.75A3 3 0 0 1 14.75 15.75H6.75",
  "M8.5 14L6.75 15.75L8.5 17.5",
];
const ONE = "M11.25 11L12.25 10.25V13.75";

interface TileIconProps {
  size?: number;
  className?: string;
}

function RepeatTileBase({ size = 18, className, one }: TileIconProps & { one: boolean }) {
  const maskId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <path d={TILE} fill="white" />
        <g stroke="black" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          {LOOP.map((d) => (
            <path key={d} d={d} />
          ))}
          {one && <path d={ONE} strokeWidth={1.4} />}
        </g>
      </mask>
      <path d={TILE} fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}

/** repeat "all" (loop the queue / playlist), active state */
export function RepeatTile(props: TileIconProps) {
  return <RepeatTileBase {...props} one={false} />;
}

/** repeat "one" (loop the current track), active state */
export function RepeatOneTile(props: TileIconProps) {
  return <RepeatTileBase {...props} one />;
}
