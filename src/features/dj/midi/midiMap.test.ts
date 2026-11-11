import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_TARGETS,
  actionForTarget,
  applyLearn,
  genericTemplate,
  normalizeMidi,
  parseMidiMessage,
  resolveAction,
  unbindTarget,
} from "./midiMap";

describe("midi parsing", () => {
  it("parses CC messages with channel", () => {
    expect(parseMidiMessage(new Uint8Array([0xb0, 14, 100]))).toEqual({
      key: "cc:1:14",
      value: 100,
    });
    expect(parseMidiMessage(new Uint8Array([0xb3, 1, 0]))?.key).toBe("cc:4:1");
  });

  it("treats note-on with velocity 0 as note-off", () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 48, 0]))).toBeNull();
    expect(parseMidiMessage(new Uint8Array([0x90, 48, 100]))).toEqual({
      key: "note:1:48",
      value: 100,
    });
  });

  it("ignores clock and sysex", () => {
    expect(parseMidiMessage(new Uint8Array([0xf8]))).toBeNull();
    expect(parseMidiMessage(new Uint8Array([0xf0, 0x01]))).toBeNull();
  });

  it("normalises 7-bit values", () => {
    expect(normalizeMidi(0)).toBe(0);
    expect(normalizeMidi(127)).toBe(1);
    expect(normalizeMidi(64)).toBeCloseTo(64 / 127);
  });
});

describe("target → action", () => {
  it("maps EQ knobs to dB", () => {
    const action = actionForTarget("a.eq.high", 1, "a");
    expect(action).toEqual({ kind: "eq", deck: "a", band: "high", value: 12 });
    const mid = actionForTarget("b.eq.low", 0.5, "a");
    expect((mid as { value: number }).value).toBeCloseTo(-6);
  });

  it("maps tempo to the ±8% range", () => {
    expect(actionForTarget("a.tempo", 0, "a")).toEqual({ kind: "tempo", deck: "a", value: -0.08 });
    expect(actionForTarget("a.tempo", 1, "a")).toEqual({ kind: "tempo", deck: "a", value: 0.08 });
  });

  it("fires momentary targets only on press", () => {
    expect(actionForTarget("a.play", 1, "a")).toEqual({ kind: "togglePlay", deck: "a" });
    expect(actionForTarget("a.play", 0, "a")).toBeNull();
  });

  it("routes mix targets", () => {
    expect(actionForTarget("mix.crossfader", 0.25, "a")).toEqual({ kind: "crossfader", value: 0.25 });
    expect(actionForTarget("mix.master", 1, "b")).toEqual({ kind: "master", value: 1 });
  });

  it("rejects unknown targets", () => {
    expect(actionForTarget("a.nonexistent", 0.5, "a")).toBeNull();
    expect(actionForTarget("mix.unknown", 0.5, "a")).toBeNull();
  });
});

describe("bindings", () => {
  it("resolves through the map with the focused deck", () => {
    const bindings = { "cc:1:14": "a.eq.high" };
    const parsed = parseMidiMessage(new Uint8Array([0xb0, 14, 127]))!;
    expect(resolveAction(parsed, bindings, "a")).toEqual({
      kind: "eq",
      deck: "a",
      band: "high",
      value: 12,
    });
    expect(resolveAction(parsed, {}, "a")).toBeNull();
  });

  it("learn moves a target instead of duplicating it", () => {
    const before = { "cc:1:14": "a.eq.high", "cc:1:15": "a.eq.mid" };
    const after = applyLearn(before, "a.eq.high", "cc:2:22");
    expect(after["cc:1:14"]).toBeUndefined();
    expect(after["cc:2:22"]).toBe("a.eq.high");
    expect(after["cc:1:15"]).toBe("a.eq.mid");
  });

  it("unbind clears every message bound to a target", () => {
    const after = unbindTarget({ "cc:1:14": "a.eq.high", "note:1:48": "a.play" }, "a.eq.high");
    expect(Object.keys(after)).toEqual(["note:1:48"]);
  });

  it("generic template binds both decks and the mix", () => {
    const map = genericTemplate();
    expect(map["cc:1:14"]).toBe("a.eq.high");
    expect(map["cc:2:16"]).toBe("b.eq.low");
    expect(map["note:2:48"]).toBe("b.play");
    expect(map["cc:1:20"]).toBe("mix.crossfader");
    // every bound target exists in the assignable list
    const ids = new Set(ASSIGNABLE_TARGETS.map((target) => target.id));
    for (const target of Object.values(map)) expect(ids.has(target)).toBe(true);
  });
});
