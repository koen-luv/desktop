import { memo } from "react";

const TRACK_TITLE_WIDTHS = [
  "w-[42%]",
  "w-[34%]",
  "w-[50%]",
  "w-[28%]",
  "w-[46%]",
  "w-[38%]",
  "w-[52%]",
  "w-[30%]",
];

const TRACK_ARTIST_WIDTHS = [
  "w-[24%]",
  "w-[18%]",
  "w-[28%]",
  "w-[22%]",
  "w-[32%]",
  "w-[20%]",
  "w-[26%]",
  "w-[16%]",
];

export interface PlaylistPageSkeletonProps {
  className?: string;
}

function PlaylistPageSkeletonComponent({
  className = "",
}: PlaylistPageSkeletonProps) {
  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-transparent select-none ${className}`}
    >
      <div className="w-full px-4 pt-[calc(var(--inset-top,0px)+64px)] md:px-[32px] md:pt-[76px]">
        <div className="flex items-start gap-4 md:gap-[22px]">
          <div className="h-[112px] w-[112px] shrink-0 overflow-hidden rounded-[14px] bg-border-alpha-14 sm:h-[144px] sm:w-[144px] md:h-[168px] md:w-[168px] md:rounded-[12px]">
            <div className="skeleton-shimmer h-full w-full" />
          </div>

          <div className="flex min-w-0 flex-1 flex-col pt-0.5 md:min-h-[168px]">
            <div className="min-h-[112px] sm:min-h-[144px] md:min-h-0">
              <div className="skeleton-shimmer h-[30px] w-[58%] rounded-[7px] sm:h-[34px]" />
              <div className="skeleton-shimmer mt-[10px] h-[13px] w-[38%] rounded-[5px]" />
              <div className="mt-[14px] flex items-center gap-[6px]">
                <div className="skeleton-shimmer h-[26px] w-[176px] rounded-[9px]" />
              </div>
            </div>

            <div className="-ml-[128px] mt-4 flex w-[calc(100%+128px)] flex-wrap items-center gap-2 sm:-ml-[160px] sm:w-[calc(100%+160px)] md:ml-0 md:mt-auto md:w-full md:pt-4">
              <div className="skeleton-shimmer h-[38px] w-[124px] rounded-full" />
              <div className="skeleton-shimmer h-[38px] w-[38px] rounded-full" />
              <div className="skeleton-shimmer order-last h-[32px] w-full rounded-md md:order-none md:ml-auto md:w-[220px] xl:w-[280px]" />
              <div className="skeleton-shimmer h-[38px] w-[38px] rounded-full sm:w-[128px]" />
              <div className="skeleton-shimmer h-[38px] w-[38px] rounded-full" />
              <div className="skeleton-shimmer h-[38px] w-[38px] rounded-full" />
            </div>
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded-[16px] bg-black/[0.035] p-[6px] shadow-[inset_0_0_0_1px_var(--border-primary)] backdrop-blur-2xl dark:bg-white/[0.05] md:mt-6 md:p-2">
          <div className="flex flex-col">
            {Array.from({ length: 9 }).map((_, index) => (
              <div
                key={index}
                className="flex h-[64px] items-center justify-between rounded-[16px] p-[8px]"
              >
                <div className="flex min-w-0 flex-1 items-center gap-[16px]">
                  <div className="skeleton-shimmer flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[10px]">
                    <div className="skeleton-shimmer h-[12px] w-[12px] rounded-[3px]" />
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
                    <div
                      className={`skeleton-shimmer h-[15px] ${
                        TRACK_TITLE_WIDTHS[index % TRACK_TITLE_WIDTHS.length]
                      } rounded-[4px]`}
                    />
                    <div
                      className={`skeleton-shimmer h-[13px] ${
                        TRACK_ARTIST_WIDTHS[index % TRACK_ARTIST_WIDTHS.length]
                      } rounded-[4px]`}
                    />
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-[16px] pr-[8px]">
                  <div className="skeleton-shimmer h-[13px] w-[36px] rounded-[4px]" />
                  <div className="skeleton-shimmer h-[20px] w-[20px] rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const PlaylistPageSkeleton = memo(PlaylistPageSkeletonComponent);
export default PlaylistPageSkeleton;
