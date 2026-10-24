import { useMemo, useState } from "react";
import Dialog from "@/shared/ui/Dialog";
import Button from "@/shared/ui/Button";
import { nativeShare } from "@/platform";
import { useTranslation } from "@/languages";
import { useListeningRecap } from "../hooks/useListeningRecap";

function formatListeningTime(milliseconds: number, t: ReturnType<typeof useTranslation>["t"]): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return t("home.recap.minute", { count: minutes });
  return remainder === 0
    ? t("home.recap.hour", { count: hours })
    : `${t("home.recap.hour", { count: hours })} ${t("home.recap.minute", { count: remainder })}`;
}

export default function ListeningRecap() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const { data, error, isLoading, load } = useListeningRecap(year);
  const [open, setOpen] = useState(false);
  const [slide, setSlide] = useState(0);
  const [shareMessage, setShareMessage] = useState("");
  const monthLabels = useMemo(
    () =>
      Array.from({ length: 12 }, (_, month) =>
        new Date(year, month, 1).toLocaleDateString(undefined, { month: "short" }),
      ),
    [year],
  );

  const openRecap = () => {
    setOpen(true);
    setSlide(0);
    setShareMessage("");
    if (!data && !isLoading) void load();
  };

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
        setShareMessage("Recap copied to clipboard");
        return;
      } catch {
        setShareMessage("Could not share or copy the recap on this device.");
        return;
      }
    }
    setShareMessage("Sharing isn’t available on this device.");
  };

  const maxMonthMs = Math.max(...(data?.monthlyListeningMs ?? [0]), 1);

  return (
    <>
      <section className="mt-[22px] px-4 md:px-8" aria-labelledby="listening-recap-title">
        <button
          type="button"
          onClick={openRecap}
          className="group relative flex min-h-[104px] w-full items-center justify-between overflow-hidden rounded-xl border border-white/10 bg-gradient-to-r from-violet-950 via-indigo-950 to-slate-950 px-5 py-4 text-left text-white transition-[transform,filter] duration-200 ease-out hover:brightness-110 active:scale-[0.995] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <span className="pointer-events-none absolute -right-8 -top-16 h-48 w-48 rounded-full bg-violet-400/15 blur-3xl" />
          <span className="relative">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-200/75">
              {t("home.recap.label")}
            </span>
            <span id="listening-recap-title" className="block text-[21px] font-semibold tracking-tight">
              {t("home.recap.cardTitle", { year })}
            </span>
            <span className="mt-1 block text-[13px] text-white/65">
              {t("home.recap.cardDescription")}
            </span>
          </span>
          <span aria-hidden="true" className="relative ml-4 text-2xl text-violet-200 transition-transform duration-200 group-hover:translate-x-1">
            →
          </span>
        </button>
      </section>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        maxWidth={640}
        maxHeight="min(760px, 90vh)"
        className="p-0"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950 p-6 text-white sm:p-8">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-200/70">
                {t("home.recap.label")}
              </p>
              <p className="m-0 mt-1 text-sm text-white/55">{year}</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              {t("home.recap.close")}
            </button>
          </div>

          {isLoading ? (
            <div className="flex min-h-[280px] flex-1 items-center justify-center text-sm text-white/70">
              {t("home.recap.loading")}
            </div>
          ) : error ? (
            <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-4 text-center">
              <p className="max-w-md text-sm text-white/75">{error}</p>
              <Button size="sm" onClick={() => void load()}>
                {t("home.recap.tryAgain")}
              </Button>
            </div>
          ) : !data || data.plays === 0 ? (
            <div className="flex min-h-[280px] flex-1 items-center justify-center text-center text-sm text-white/70">
              {t("home.recap.empty", { year })}
            </div>
          ) : (
            <>
              {data.isPartial && (
                <p className="mb-4 rounded-lg bg-white/[0.07] px-3 py-2 text-xs text-white/65">
                  {t("home.recap.partial")}
                </p>
              )}
              <div className="min-h-[280px] flex-1">
                {slide === 0 && (
                  <div className="flex h-full flex-col justify-center">
                    <p className="mb-3 text-sm text-violet-200/75">{t("home.recap.thisYear")}</p>
                    <h2 className="m-0 text-5xl font-bold tracking-tight sm:text-6xl">
                      {formatListeningTime(data.listenedMs, t)}
                    </h2>
                    <p className="mt-3 text-lg text-white/75">{t("home.recap.withMusic")}</p>
                    <div className="mt-8 grid grid-cols-3 gap-3">
                      {[
                        [data.plays.toLocaleString(), t("home.recap.plays")],
                        [data.uniqueTracks.toLocaleString(), t("home.recap.tracks")],
                        [data.activeDays.toLocaleString(), t("home.recap.daysListened")],
                      ].map(([value, label]) => (
                        <div key={label} className="rounded-xl bg-white/[0.07] p-3">
                          <span className="block text-xl font-semibold">{value}</span>
                          <span className="mt-1 block text-xs text-white/55">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {slide === 1 && (
                  <div>
                    <p className="mb-2 text-sm text-violet-200/75">{t("home.recap.onRepeat")}</p>
                    <h2 className="mb-6 mt-0 text-3xl font-bold">{t("home.recap.topTracks")}</h2>
                    <ol className="m-0 list-none space-y-3 p-0">
                      {data.topTracks.slice(0, 5).map((track, index) => (
                        <li key={track.id} className="flex items-center gap-3 rounded-xl bg-white/[0.07] p-3">
                          <span className="w-6 shrink-0 text-sm font-semibold text-violet-200/70">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          {track.coverUrl ? (
                            <img src={track.coverUrl} alt="" className="h-11 w-11 rounded-md object-cover" />
                          ) : (
                            <span aria-hidden="true" className="h-11 w-11 rounded-md bg-white/10" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold">{track.title}</span>
                            <span className="block truncate text-xs text-white/55">{track.artists || "Unknown artist"}</span>
                          </span>
                          <span className="shrink-0 text-xs text-white/55">
                            {t("home.recap.playCount", { count: track.plays })}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {slide === 2 && (
                  <div>
                    <p className="mb-2 text-sm text-violet-200/75">{t("home.recap.personality")}</p>
                    <h2 className="mb-6 mt-0 text-3xl font-bold">
                      {data.topArtists[0]?.name
                        ? t("home.recap.yearWithArtist", { artist: data.topArtists[0].name })
                        : t("home.recap.yearInSound")}
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        [t("home.recap.topArtist"), data.topArtists[0]?.name ?? "—"],
                        [t("home.recap.topMonth"), data.topMonth ?? "—"],
                        [t("home.recap.longestDay"), data.topDay ?? "—"],
                        [t("home.recap.artistsExplored"), data.uniqueArtists.toLocaleString()],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-xl bg-white/[0.07] p-4">
                          <span className="block text-xs text-white/55">{label}</span>
                          <span className="mt-1 block truncate text-lg font-semibold">{value}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-7 flex h-20 items-end gap-1.5" aria-label="Listening time by month">
                      {data.monthlyListeningMs.map((duration, index) => (
                        <div key={index} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                          <div
                            className="w-full rounded-t-sm bg-violet-300/80"
                            style={{ height: `${Math.max(duration > 0 ? 8 : 2, (duration / maxMonthMs) * 56)}px` }}
                            title={`${monthLabels[index]}: ${formatListeningTime(duration, t)}`}
                          />
                          <span className="text-[9px] text-white/45">{monthLabels[index]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-7 flex items-center justify-between border-t border-white/10 pt-4">
                <span className="text-xs text-white/50">{slide + 1} / 3</span>
                <div className="flex gap-2">
                  {slide > 0 && (
                    <Button
                      variant="glass"
                      size="sm"
                      onClick={() => setSlide((current) => Math.max(0, current - 1))}
                    >
                      {t("home.recap.back")}
                    </Button>
                  )}
                  {slide < 2 ? (
                    <Button
                      size="sm"
                      onClick={() => setSlide((current) => Math.min(2, current + 1))}
                    >
                      {t("home.recap.next")}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => void shareRecap()}>
                      {t("home.recap.share")}
                    </Button>
                  )}
                </div>
              </div>
              {shareMessage && (
                <p role="status" className="mb-0 mt-3 text-right text-xs text-white/65">
                  {shareMessage === "Recap copied to clipboard"
                    ? t("home.recap.copied")
                    : shareMessage === "Sharing isn’t available on this device."
                      ? t("home.recap.shareUnavailable")
                      : t("home.recap.shareFailed")}
                </p>
              )}
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
