import { memo } from "react";

const TRACK_TITLE_WIDTHS = [
  "w-[38%]",
  "w-[48%]",
  "w-[32%]",
  "w-[44%]",
  "w-[54%]",
  "w-[36%]",
  "w-[46%]",
  "w-[40%]",
];

const TRACK_ARTIST_WIDTHS = [
  "w-[22%]",
  "w-[28%]",
  "w-[18%]",
  "w-[24%]",
  "w-[30%]",
  "w-[20%]",
  "w-[26%]",
  "w-[22%]",
];

export interface CollectionPageSkeletonProps {
  className?: string;
  isAlbum?: boolean;
}

// matches the sidebar + track list layout
function CollectionPageSkeletonComponent({
  className = "",
  isAlbum = true,
}: CollectionPageSkeletonProps) {
  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-transparent select-none ${className}`}
    >
      <div className="relative z-10 flex flex-row items-stretch gap-[24px] pl-[32px] pr-[20px] h-full w-full min-h-0 box-border">
        <aside className="shrink-0 w-[280px] self-start pt-[56px] pb-[24px]">
          <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-bg-panel">
            <div className="skeleton-shimmer h-full w-full" />
          </div>

          <div className="skeleton-shimmer h-[28px] w-[80%] rounded-[7px] mt-[18px]" />
          <div className="skeleton-shimmer h-[15px] w-[60%] rounded-[4px] mt-[7px]" />
          <div className="skeleton-shimmer h-[26px] w-[150px] rounded-full mt-[10px]" />

          <div className="skeleton-shimmer h-[38px] w-full rounded-lg mt-[18px]" />
          <div className="mt-[8px] flex items-center gap-[8px]">
            <div className="skeleton-shimmer h-[38px] flex-1 rounded-lg" />
            <div className="skeleton-shimmer h-[38px] w-[38px] rounded-lg" />
            <div className="skeleton-shimmer h-[38px] w-[38px] rounded-lg" />
          </div>
        </aside>

        <div className="min-w-0 flex-1 h-full min-h-0 overflow-hidden px-[8px] pt-[56px] pb-[24px]">
          <div className="flex flex-col">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg p-[8px] h-[60px]"
              >
                <div className="flex items-center gap-[14px] min-w-0 flex-1">
                  {isAlbum ? (
                    <div className="flex h-[44px] w-[44px] shrink-0 items-center justify-center">
                      <div className="skeleton-shimmer h-[14px] w-[18px] rounded-[3px]" />
                    </div>
                  ) : (
                    <div className="skeleton-shimmer h-[44px] w-[44px] shrink-0 rounded-lg" />
                  )}

                  <div className="min-w-0 flex flex-col gap-[6px] flex-1">
                    <div
                      className={`skeleton-shimmer h-[15px] ${TRACK_TITLE_WIDTHS[i % TRACK_TITLE_WIDTHS.length]} rounded-[4px]`}
                    />
                    <div
                      className={`skeleton-shimmer h-[13px] ${TRACK_ARTIST_WIDTHS[i % TRACK_ARTIST_WIDTHS.length]} rounded-[4px]`}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-[16px] pr-[8px]">
                  <div className="skeleton-shimmer h-[13px] w-[36px] rounded-[4px]" />
                  <div className="skeleton-shimmer h-[30px] w-[30px] rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const CollectionPageSkeleton = memo(CollectionPageSkeletonComponent);
export default CollectionPageSkeleton;
