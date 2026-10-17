import { useEffect, useState } from "react";
import { usePlayerStore } from "../store/playerStore";
import { sleepRemainingMs } from "../engine/sleepTimer";

/**
 * Remaining sleep-timer milliseconds, ticking once a second while a timer is
 * armed (returns 0 when off/expired). Drives the countdown labels.
 */
export function useSleepTimerRemainingMs(): number {
  const endsAt = usePlayerStore((s) => s.sleepTimerEndsAtMs);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!endsAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  return sleepRemainingMs(endsAt, now);
}
