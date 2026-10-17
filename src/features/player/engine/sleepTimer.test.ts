import { describe, it, expect } from "vitest";
import {
  SLEEP_TIMER_PRESETS_MINUTES,
  sleepDeadlineFromMinutes,
  sleepRemainingMs,
  formatSleepRemaining,
} from "./sleepTimer";
import { usePlayerStore } from "../store/playerStore";

const NOW = 1_700_000_000_000;

describe("sleep timer helpers", () => {
  it("offers minute presets in ascending order", () => {
    expect([...SLEEP_TIMER_PRESETS_MINUTES]).toEqual([15, 30, 45, 60, 90]);
  });

  it("turns minutes into an absolute deadline", () => {
    expect(sleepDeadlineFromMinutes(30, NOW)).toBe(NOW + 30 * 60_000);
  });

  it("never produces a non-positive duration", () => {
    expect(sleepDeadlineFromMinutes(0, NOW)).toBe(NOW + 60_000);
    expect(sleepDeadlineFromMinutes(-5, NOW)).toBe(NOW + 60_000);
  });

  it("reports remaining time, clamped at zero", () => {
    expect(sleepRemainingMs(NOW + 5_000, NOW)).toBe(5_000);
    expect(sleepRemainingMs(NOW - 5_000, NOW)).toBe(0);
    expect(sleepRemainingMs(null, NOW)).toBe(0);
  });

  it("formats a countdown as m:ss", () => {
    expect(formatSleepRemaining(0)).toBe("0:00");
    expect(formatSleepRemaining(1_000)).toBe("0:01");
    expect(formatSleepRemaining(61_000)).toBe("1:01");
    expect(formatSleepRemaining(90 * 60_000)).toBe("90:00");
  });
});

describe("playerStore sleep timer", () => {
  it("sets and clears the deadline", () => {
    usePlayerStore.getState().setSleepTimer(12345);
    expect(usePlayerStore.getState().sleepTimerEndsAtMs).toBe(12345);
    usePlayerStore.getState().setSleepTimer(null);
    expect(usePlayerStore.getState().sleepTimerEndsAtMs).toBeNull();
  });
});
