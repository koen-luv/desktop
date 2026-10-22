import { afterEach, describe, expect, it } from "vitest";
import {
  isPlaybackLocked,
  resetPlaybackLock,
  setPlaybackLock,
  withPlaybackLockBypass,
} from "./playbackLock";

afterEach(() => resetPlaybackLock());

describe("playbackLock", () => {
  it("is open by default", () => {
    expect(isPlaybackLocked()).toBe(false);
  });

  it("locks when engaged and releases again", () => {
    setPlaybackLock(true);
    expect(isPlaybackLocked()).toBe(true);
    setPlaybackLock(false);
    expect(isPlaybackLocked()).toBe(false);
  });

  it("opens only for the duration of a bypass", () => {
    setPlaybackLock(true);
    const seen: boolean[] = [];
    withPlaybackLockBypass(() => {
      seen.push(isPlaybackLocked());
    });
    seen.push(isPlaybackLocked());
    expect(seen).toEqual([false, true]);
  });

  it("stays open until the outermost bypass exits", () => {
    setPlaybackLock(true);
    const seen: boolean[] = [];
    withPlaybackLockBypass(() => {
      seen.push(isPlaybackLocked());
      withPlaybackLockBypass(() => {
        seen.push(isPlaybackLocked());
      });
      seen.push(isPlaybackLocked());
    });
    seen.push(isPlaybackLocked());
    expect(seen).toEqual([false, false, false, true]);
  });

  it("releases the bypass even when the wrapped call throws", () => {
    setPlaybackLock(true);
    expect(() =>
      withPlaybackLockBypass(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(isPlaybackLocked()).toBe(true);
  });

  it("passes the wrapped value through", () => {
    expect(withPlaybackLockBypass(() => 42)).toBe(42);
  });
});
