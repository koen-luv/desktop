import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNELS,
  anySoloed,
  effectiveGain,
  mixGains,
  type StemChannel,
} from "./mix";

const channel = (patch: Partial<StemChannel>): StemChannel => ({
  ...DEFAULT_CHANNELS[0],
  ...patch,
});

describe("stem mixer", () => {
  it("passes the fader level through when nothing is muted or soloed", () => {
    const channels = [channel({ level: 0.4 }), channel({ name: "drums", level: 0.9 })];
    expect(mixGains(channels)).toEqual([0.4, 0.9]);
  });

  it("silences a muted channel", () => {
    expect(effectiveGain(channel({ muted: true, level: 1 }), [])).toBe(0);
  });

  it("silences everything that is not soloed", () => {
    const channels = [
      channel({ name: "vocals", solo: true, level: 0.7 }),
      channel({ name: "drums", level: 1 }),
      channel({ name: "bass", level: 1 }),
    ];
    expect(anySoloed(channels)).toBe(true);
    expect(mixGains(channels)).toEqual([0.7, 0, 0]);
  });

  it("lets several solos play together", () => {
    const channels = [
      channel({ name: "vocals", solo: true }),
      channel({ name: "drums", solo: true }),
      channel({ name: "bass" }),
    ];
    expect(mixGains(channels)).toEqual([1, 1, 0]);
  });

  it("keeps mute winning over solo", () => {
    const channels = [channel({ name: "vocals", solo: true, muted: true }), channel({ name: "drums" })];
    expect(mixGains(channels)).toEqual([0, 0]);
  });

  it("clamps fader values", () => {
    expect(effectiveGain(channel({ level: 4 }), [])).toBe(1);
    expect(effectiveGain(channel({ level: -2 }), [])).toBe(0);
  });
});
