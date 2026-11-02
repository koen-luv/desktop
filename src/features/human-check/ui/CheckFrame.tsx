import { useEffect, useRef } from "react";
import { cn } from "@/shared/utils/cn";
import {
  humanCheckOrigin,
  humanCheckPageUrl,
  type HumanCheckAction,
  type HumanCheckRequest,
} from "@/shared/api";
import { useHumanCheckStore } from "../store/humanCheckStore";
import { loadTurnstile, TURNSTILE_SITE_KEY } from "../turnstile";

export interface CheckFrameProps {
  request: HumanCheckRequest;
  attempt: number;
}

const skeleton =
  "absolute inset-x-[10px] top-[11px] h-[65px] animate-pulse rounded-[10px] bg-black/[0.08] transition-opacity duration-300 dark:bg-white/[0.1]";

/** the packaged desktop build cannot host a widget: file:// has no hostname to verify */
function runsFromFile(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "file:";
}

export default function CheckFrame({ request, attempt }: CheckFrameProps) {
  if (request.edge || runsFromFile()) {
    return <HostedCheck action={request.action} attempt={attempt} />;
  }
  return <TurnstileCheck action={request.action} attempt={attempt} />;
}

/**
 * Renders the widget created for Liner in the app itself and hands its token
 * straight to the auth flow.
 */
function TurnstileCheck({
  action,
  attempt,
}: {
  action: HumanCheckAction;
  attempt: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const phase = useHumanCheckStore((state) => state.phase);
  const setPhase = useHumanCheckStore((state) => state.setPhase);
  const solve = useHumanCheckStore((state) => state.solve);
  const ready = phase !== "loading";

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let widgetId: string | undefined;

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        widgetId = turnstile.render(container, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          theme: "dark",
          callback: (token) => solve(token),
          "expired-callback": () => setPhase("expired"),
          "error-callback": () => setPhase("error"),
        });
        if (useHumanCheckStore.getState().phase === "loading") setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });

    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
      container.replaceChildren();
    };
  }, [action, attempt, setPhase, solve]);

  return (
    <div className="relative mx-auto flex h-[88px] w-[320px] shrink-0 items-center justify-center">
      <div className={cn(skeleton, ready && "opacity-0")} />
      <div
        ref={containerRef}
        className={cn(
          "relative transition-opacity duration-300 ease-out",
          ready ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

/**
 * The api serves the same check on its own origin. Used when the edge wants a
 * clearance cookie for that origin, and on file:// where a widget has nowhere to
 * run. The page posts `{source, action, type, token}` back to us.
 */
function HostedCheck({
  action,
  attempt,
}: {
  action: HumanCheckAction;
  attempt: number;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const phase = useHumanCheckStore((state) => state.phase);
  const setPhase = useHumanCheckStore((state) => state.setPhase);
  const solve = useHumanCheckStore((state) => state.solve);
  const ready = phase !== "loading";

  useEffect(() => {
    const origin = humanCheckOrigin();
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as {
        source?: string;
        action?: string;
        type?: string;
        token?: string;
      } | null;
      if (data?.source !== "liner-turnstile" || data.action !== action) return;
      if (data.type === "token" && data.token) solve(data.token);
      else if (data.type === "expired") setPhase("expired");
      else if (data.type === "error") setPhase("error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [action, setPhase, solve]);

  const markLoaded = () => {
    if (useHumanCheckStore.getState().phase === "loading") setPhase("ready");
  };

  return (
    <div className="relative mx-auto h-[88px] w-[320px] shrink-0">
      <div className={cn(skeleton, ready && "opacity-0")} />
      <iframe
        key={attempt}
        ref={frameRef}
        src={humanCheckPageUrl(action)}
        title="Cloudflare Turnstile"
        scrolling="no"
        onLoad={markLoaded}
        className={cn(
          "absolute inset-0 size-full border-0 bg-transparent opacity-0 transition-opacity duration-300 ease-out [color-scheme:dark]",
          ready && "opacity-100",
        )}
      />
    </div>
  );
}
