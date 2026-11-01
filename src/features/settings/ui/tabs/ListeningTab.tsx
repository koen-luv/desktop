import { useEffect, useMemo, useState } from "react";
import { useTranslation, getTranslationsForAllLocales } from "@/languages";
import Button from "@/shared/ui/Button";
import { nativeShare } from "@/platform";
import { useListeningRecap } from "@/features/home/hooks/useListeningRecap";

const font = { fontFamily: "var(--font-inter), sans-serif" } as const;

function formatListeningTime(
  milliseconds: number,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return t("home.recap.minute", { count: minutes });
  return remainder === 0
    ? t("home.recap.hour", { count: hours })
    : `${t("home.recap.hour", { count: hours })} ${t("home.recap.minute", { count: remainder })}`;
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[2px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[10px]">
      <span className="truncate text-[17px] font-[600] leading-tight text-text-primary" style={font}>
        {value}
      </span>
      <span className="truncate text-[11.5px] text-text-tertiary" style={font}>
        {label}
      </span>
    </div>
  );
}

/**
 * Everything the yearly recap used to show in a slide deck, in one scrollable
 * settings screen. Replaces the home card so the numbers live where people
 * look for account information.
 */
export function ListeningTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const { data, error, isLoading, load } = useListeningRecap(year);
  const [shareMessage, setShareMessage] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const isMatch = useMemo(() => {
    if (!searchQuery?.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    const keys = [
      "settings.listening.title",
      "settings.listening.description",
      "home.recap.topTracks",
      "home.recap.topArtist",
      "home.recap.plays",
    ];
    return keys.some((key) =>
      getTranslationsForAllLocales(key).some((text) => text.toLowerCase().includes(q)),
    );
  }, [searchQuery]);

  const monthLabels = useMemo(
    () =>
      Array.from({ length: 12 }, (_, month) =>
        new Date(year, month, 1).toLocaleDateString(undefined, { month: "short" }),
      ),
    [year],
  );

  const shareRecap = async () => {
    if (!data) return;
    const topTrack = data.topTracks[0];
    const topArtist = data.topArtists[0];
    const summary = [
      t("home.recap.shareTitle", { year: data.year }),
      t("home.recap.shareListening", {
        time: formatListeningTime(data.listenedMs, t),
        count: data.plays,
      }),
      t("home.recap.shareDiscoveries", {
        tracks: data.uniqueTracks,
        artists: data.uniqueArtists,
      }),
      topArtist ? t("home.recap.shareTopArtist", { artist: topArtist.name }) : "",
      topTrack
        ? t("home.recap.shareTopTrack", {
            track: `${topTrack.title}${topTrack.artists ? ` — ${topTrack.artists}` : ""}`,
          })
        : "",
      t("home.recap.shareTag"),
    ]
      .filter(Boolean)
      .join("\n");

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ text: summary });
        setShareMessage("");
        return;
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") return;
      }
    }
    if (nativeShare(summary)) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(summary);
        setShareMessage(t("home.recap.copied"));
        return;
      } catch {
        setShareMessage(t("home.recap.shareFailed"));
        return;
      }
    }
    setShareMessage(t("home.recap.shareUnavailable"));
  };

  if (!isMatch) return null;

  const maxMonthMs = Math.max(...(data?.monthlyListeningMs ?? [0]), 1);

  return (
    <div className="flex flex-col gap-[12px] py-[13px]">
      <div className="flex min-w-0 max-w-[460px] flex-col gap-[2px]">
        <span className="text-text-primary text-[13px] font-[500] leading-snug" style={font}>
          {t("settings.listening.stats_title")}
        </span>
        <span className="text-text-tertiary text-[12.5px] leading-relaxed" style={font}>
          {t("settings.listening.stats_description", { year })}
        </span>
      </div>

      {isLoading ? (
        <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-border-primary bg-bg-primary">
          <span className="h-[16px] w-[16px] animate-spin rounded-full border-2 border-text-tertiary border-t-text-primary" />
        </div>
      ) : error ? (
        <div className="flex flex-col gap-[8px] rounded-lg border border-border-primary bg-bg-primary p-[12px]">
          <span className="text-[12.5px] text-text-tertiary" style={font}>
            {error}
          </span>
          <div>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("home.recap.tryAgain")}
            </Button>
          </div>
        </div>
      ) : !data || data.plays === 0 ? (
        <div className="rounded-lg border border-border-primary bg-bg-primary p-[12px]">
          <span className="text-[12.5px] text-text-tertiary" style={font}>
            {t("home.recap.empty", { year })}
          </span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-[8px] sm:grid-cols-3">
            <StatCard value={formatListeningTime(data.listenedMs, t)} label={t("home.recap.timeLabel")} />
            <StatCard value={data.plays.toLocaleString()} label={t("home.recap.plays")} />
            <StatCard value={data.uniqueTracks.toLocaleString()} label={t("home.recap.tracks")} />
            <StatCard value={data.uniqueArtists.toLocaleString()} label={t("home.recap.artistsExplored")} />
            <StatCard value={data.activeDays.toLocaleString()} label={t("home.recap.daysListened")} />
            <StatCard value={data.topMonth ?? "—"} label={t("home.recap.topMonth")} />
          </div>

          {data.isPartial ? (
            <p className="m-0 rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[8px] text-[11.5px] text-text-tertiary" style={font}>
              {t("home.recap.partial")}
            </p>
          ) : null}

          <div className="flex flex-col gap-[6px] rounded-lg border border-border-primary bg-bg-primary p-[12px]">
            <span className="text-[12px] font-[500] text-text-secondary" style={font}>
              {t("settings.listening.by_month")}
            </span>
            <div className="flex h-[72px] items-end gap-[3px]">
              {data.monthlyListeningMs.map((duration, index) => (
                <div key={index} className="flex h-full flex-1 flex-col items-center justify-end gap-[3px]">
                  <div
                    className="w-full rounded-t-sm bg-accent-primary/70"
                    style={{
                      height: `${Math.max(duration > 0 ? 6 : 2, (duration / maxMonthMs) * 52)}px`,
                    }}
                    title={`${monthLabels[index]}: ${formatListeningTime(duration, t)}`}
                  />
                  <span className="text-[9px] text-text-tertiary">{monthLabels[index]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-[500] text-text-secondary" style={font}>
              {t("home.recap.topTracks")}
            </span>
            <ol className="m-0 flex list-none flex-col gap-[4px] p-0">
              {data.topTracks.map((track, index) => (
                <li
                  key={track.id}
                  className="flex items-center gap-[10px] rounded-lg border border-border-primary bg-bg-primary px-[10px] py-[8px]"
                >
                  <span className="w-[16px] shrink-0 text-[11.5px] font-[600] text-text-tertiary">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {track.coverUrl ? (
                    <img src={track.coverUrl} alt="" className="h-[32px] w-[32px] shrink-0 rounded-md object-cover" />
                  ) : (
                    <span aria-hidden="true" className="h-[32px] w-[32px] shrink-0 rounded-md bg-bg-hover" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-[500] text-text-primary" style={font}>
                      {track.title}
                    </span>
                    <span className="block truncate text-[11.5px] text-text-tertiary" style={font}>
                      {track.artists || t("home.recap.unknownArtist")}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-text-tertiary" style={font}>
                    {t("home.recap.playCount", { count: track.plays })}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-[500] text-text-secondary" style={font}>
              {t("home.recap.topArtist")}
            </span>
            <ol className="m-0 flex list-none flex-col gap-[4px] p-0">
              {data.topArtists.map((artist, index) => (
                <li
                  key={artist.name}
                  className="flex items-center gap-[10px] rounded-lg border border-border-primary bg-bg-primary px-[10px] py-[8px]"
                >
                  <span className="w-[16px] shrink-0 text-[11.5px] font-[600] text-text-tertiary">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-[500] text-text-primary" style={font}>
                    {artist.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-tertiary" style={font}>
                    {t("home.recap.playCount", { count: artist.plays })}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="flex flex-wrap items-center gap-[8px]">
            <Button variant="secondary" size="sm" onClick={() => void shareRecap()}>
              {t("home.recap.share")}
            </Button>
            {data.topDay ? (
              <span className="text-[11.5px] text-text-tertiary" style={font}>
                {t("home.recap.longestDay")}: {data.topDay}
              </span>
            ) : null}
          </div>
          {shareMessage ? (
            <p role="status" className="m-0 text-[11.5px] text-text-tertiary" style={font}>
              {shareMessage}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
