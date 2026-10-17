import { usePlayerStore } from "../store/playerStore";
import { useSleepTimerRemainingMs } from "../hooks/useSleepTimer";
import {
  SLEEP_TIMER_PRESETS_MINUTES,
  sleepDeadlineFromMinutes,
  formatSleepRemaining,
} from "../engine/sleepTimer";
import { useTranslation } from "@/languages";

const chipClass =
  "h-[26px] min-w-[30px] px-[9px] rounded-md text-[12px] font-medium leading-none bg-border-alpha-14 hover:bg-border-alpha-20 text-text-secondary hover:text-text-primary transition-colors cursor-pointer border-none";

/**
 * Countdown + preset picker for the sleep timer. Reads/writes the shared player
 * store; both engines react to the deadline (JS timeout on web/Electron,
 * native Media3 handler on Android). `onDone` lets the caller (e.g. the player
 * popover) close after a choice.
 */
export function SleepTimerControl({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const endsAt = usePlayerStore((s) => s.sleepTimerEndsAtMs);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const remaining = useSleepTimerRemainingMs();
  const active = Boolean(endsAt) && remaining > 0;

  const pick = (minutes: number | null) => {
    setSleepTimer(minutes === null ? null : sleepDeadlineFromMinutes(minutes));
    onDone?.();
  };

  return (
    <div className="flex items-center gap-[6px] flex-wrap">
      <span
        className={`text-[12px] tabular-nums min-w-[40px] ${
          active ? "text-text-primary" : "text-text-tertiary"
        }`}
      >
        {active ? formatSleepRemaining(remaining) : t("player.sleep_timer.off")}
      </span>
      <button
        type="button"
        onClick={() => pick(null)}
        className={`${chipClass} ${!active ? "!bg-border-alpha-20 !text-text-primary" : ""}`}
      >
        {t("player.sleep_timer.off")}
      </button>
      {SLEEP_TIMER_PRESETS_MINUTES.map((minutes) => (
        <button
          key={minutes}
          type="button"
          onClick={() => pick(minutes)}
          className={chipClass}
        >
          {minutes}
        </button>
      ))}
    </div>
  );
}

export default SleepTimerControl;
