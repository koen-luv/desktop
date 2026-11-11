/**
 * MIDI controller mapping — pure part.
 *
 * Parses raw MIDI bytes into control identities, resolves them against the
 * user's binding map, and defines the assignable action space. The hook and UI
 * are thin layers over these functions so the mapping logic is testable
 * without Web MIDI or hardware.
 */

export type DeckSide = "a" | "b";

/** Every control a MIDI message can drive. */
export type DjAction =
  | { kind: "selectDeck"; deck: DeckSide }
  | { kind: "togglePlay"; deck: DeckSide }
  | { kind: "cue"; deck: DeckSide }
  | { kind: "sync"; deck: DeckSide }
  | { kind: "loopBeats"; deck: DeckSide; beats: number }
  | { kind: "exitLoop"; deck: DeckSide }
  | { kind: "hotcueSet"; deck: DeckSide; index: number }
  | { kind: "hotcueGo"; deck: DeckSide; index: number }
  | { kind: "hotcueClear"; deck: DeckSide; index: number }
  | { kind: "eq"; deck: DeckSide; band: "low" | "mid" | "high"; value: number }
  | { kind: "fx"; deck: DeckSide; key: "filter" | "echo" | "reverb"; value: number }
  | { kind: "trim"; deck: DeckSide; value: number }
  | { kind: "tempo"; deck: DeckSide; value: number }
  | { kind: "crossfader"; value: number }
  | { kind: "master"; value: number }
  | { kind: "quantise" };

/** Identifies a control surface message independent of mapping. */
export type MidiEventKey = string; // "cc:{channel}:{controller}" | "note:{channel}:{note}"

export interface ParsedMidi {
  key: MidiEventKey;
  /** 0..127 raw value (notes: velocity; note-off is filtered out earlier). */
  value: number;
}

/** Parse one MIDI message. Returns null for clock/sysex/unhandled types. */
export function parseMidiMessage(bytes: Uint8Array): ParsedMidi | null {
  if (bytes.length < 2) return null;
  const status = bytes[0];
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  switch (type) {
    case 0x90: {
      const note = bytes[1];
      const velocity = bytes[2] ?? 0;
      // Note-off (velocity 0) must not retrigger pads.
      if (velocity === 0) return null;
      return { key: `note:${channel}:${note}`, value: velocity };
    }
    case 0x80:
      return null;
    case 0xb0:
      return { key: `cc:${channel}:${bytes[1]}`, value: bytes[2] ?? 0 };
    default:
      return null;
  }
}

export function normalizeMidi(value127: number): number {
  return Math.min(1, Math.max(0, value127 / 127));
}

export function mapRange(normalized: number, min: number, max: number): number {
  return min + normalized * (max - min);
}

/** The full list of assignable targets, for the learn UI. */
export interface AssignableTarget {
  id: string;
  label: string;
  group: string;
}

export const ASSIGNABLE_TARGETS: AssignableTarget[] = [
  ...(["a", "b"] as const).flatMap((deck) => [
    { id: `${deck}.select`, label: `Deck ${deck.toUpperCase()} select`, group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.play`, label: "Play / pause", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.cue`, label: "Cue", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.sync`, label: "Sync", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.eq.high`, label: "EQ high", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.eq.mid`, label: "EQ mid", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.eq.low`, label: "EQ low", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.fx.filter`, label: "Filter", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.fx.echo`, label: "Echo", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.fx.reverb`, label: "Reverb", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.trim`, label: "Trim", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.tempo`, label: "Tempo", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.loop.half`, label: "Loop 1/2", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.loop.one`, label: "Loop 1", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.loop.two`, label: "Loop 2", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.loop.four`, label: "Loop 4", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.loop.eight`, label: "Loop 8", group: `Deck ${deck.toUpperCase()}` },
    { id: `${deck}.loop.exit`, label: "Exit loop", group: `Deck ${deck.toUpperCase()}` },
    ...[0, 1, 2, 3].map((index) => ({
      id: `${deck}.hotcue.go.${index}`,
      label: `Hotcue ${index + 1}`,
      group: `Deck ${deck.toUpperCase()}`,
    })),
    ...[0, 1, 2, 3].map((index) => ({
      id: `${deck}.hotcue.set.${index}`,
      label: `Set hotcue ${index + 1}`,
      group: `Deck ${deck.toUpperCase()}`,
    })),
  ]),
  { id: "mix.crossfader", label: "Crossfader", group: "Mix" },
  { id: "mix.master", label: "Master", group: "Mix" },
  { id: "mix.quantise", label: "Quantise toggle", group: "Mix" },
];

/** target id → action, given a normalised value and the focused deck. */
export function actionForTarget(
  targetId: string,
  value01: number,
  focused: DeckSide,
): DjAction | null {
  const [scope, ...rest] = targetId.split(".");
  const path = rest.join(".");
  const deck = (scope === "a" || scope === "b" ? scope : null) as DeckSide | null;

  if (scope === "mix") {
    if (path === "crossfader") return { kind: "crossfader", value: value01 };
    if (path === "master") return { kind: "master", value: value01 };
    if (path === "quantise") return value01 >= 0.5 ? { kind: "quantise" } : null;
    return null;
  }
  if (!deck) return null;

  switch (path) {
    case "select":
      return value01 >= 0.5 ? { kind: "selectDeck", deck } : null;
    case "play":
      return value01 >= 0.5 ? { kind: "togglePlay", deck } : null;
    case "cue":
      return value01 >= 0.5 ? { kind: "cue", deck } : null;
    case "sync":
      return value01 >= 0.5 ? { kind: "sync", deck } : null;
    case "loop.half":
      return value01 >= 0.5 ? { kind: "loopBeats", deck, beats: 0.5 } : null;
    case "loop.one":
      return value01 >= 0.5 ? { kind: "loopBeats", deck, beats: 1 } : null;
    case "loop.two":
      return value01 >= 0.5 ? { kind: "loopBeats", deck, beats: 2 } : null;
    case "loop.four":
      return value01 >= 0.5 ? { kind: "loopBeats", deck, beats: 4 } : null;
    case "loop.eight":
      return value01 >= 0.5 ? { kind: "loopBeats", deck, beats: 8 } : null;
    case "loop.exit":
      return value01 >= 0.5 ? { kind: "exitLoop", deck } : null;
    case "trim":
      return { kind: "trim", deck, value: value01 };
    case "tempo":
      return { kind: "tempo", deck, value: mapRange(value01, -0.08, 0.08) };
    default:
      break;
  }
  if (path.startsWith("eq.")) {
    const band = path.slice(3) as "low" | "mid" | "high";
    if (["low", "mid", "high"].includes(band)) {
      return { kind: "eq", deck, band, value: mapRange(value01, -24, 12) };
    }
  }
  if (path.startsWith("fx.")) {
    const key = path.slice(3) as "filter" | "echo" | "reverb";
    if (["filter", "echo", "reverb"].includes(key)) {
      return { kind: "fx", deck, key, value: value01 };
    }
  }
  if (path.startsWith("hotcue.go.")) {
    return value01 >= 0.5 ? { kind: "hotcueGo", deck, index: Number(path.slice(12)) } : null;
  }
  if (path.startsWith("hotcue.set.")) {
    return value01 >= 0.5 ? { kind: "hotcueSet", deck, index: Number(path.slice(13)) } : null;
  }
  return null;
}

export type BindingMap = Record<MidiEventKey, string>;

/** Resolve a parsed message to an action through the map. */
export function resolveAction(
  parsed: ParsedMidi,
  bindings: BindingMap,
  focused: DeckSide,
): DjAction | null {
  const target = bindings[parsed.key];
  if (!target) return null;
  return actionForTarget(target, normalizeMidi(parsed.value), focused);
}

/**
 * Generic two-deck template: channel 1 = deck A, channel 2 = deck B. Matches
 * the layout most class-compliant DJ controllers use (knobs top-to-bottom,
 * pads as notes). Every entry stays editable through learn mode.
 */
export function genericTemplate(): BindingMap {
  const map: BindingMap = {};
  const perDeck: Array<[string, string]> = [
    ["cc", "14"], // hardware order: high, mid, low
    ["cc", "15"],
    ["cc", "16"],
  ];
  (["a", "b"] as const).forEach((deck, deckIndex) => {
    const channel = deckIndex + 1;
    const eqTargets = [`${deck}.eq.high`, `${deck}.eq.mid`, `${deck}.eq.low`];
    perDeck.forEach(([, number], index) => {
      map[`cc:${channel}:${number}`] = eqTargets[index];
    });
    map[`cc:${channel}:1`] = `${deck}.fx.filter`;
    map[`cc:${channel}:2`] = `${deck}.fx.echo`;
    map[`cc:${channel}:3`] = `${deck}.fx.reverb`;
    map[`cc:${channel}:7`] = `${deck}.trim`;
    map[`cc:${channel}:8`] = `${deck}.tempo`;
    map[`note:${channel}:48`] = `${deck}.play`;
    map[`note:${channel}:49`] = `${deck}.cue`;
    map[`note:${channel}:50`] = `${deck}.sync`;
    map[`note:${channel}:56`] = `${deck}.loop.half`;
    map[`note:${channel}:57`] = `${deck}.loop.one`;
    map[`note:${channel}:58`] = `${deck}.loop.two`;
    map[`note:${channel}:59`] = `${deck}.loop.four`;
    map[`note:${channel}:60`] = `${deck}.loop.eight`;
    map[`note:${channel}:61`] = `${deck}.loop.exit`;
    for (let pad = 0; pad < 4; pad += 1) {
      map[`note:${channel}:${64 + pad}`] = `${deck}.hotcue.go.${pad}`;
      map[`note:${channel}:${72 + pad}`] = `${deck}.hotcue.set.${pad}`;
    }
    map[`note:${channel}:80`] = `${deck}.select`;
  });
  map["cc:1:20"] = "mix.crossfader";
  map["cc:1:21"] = "mix.master";
  map["note:1:81"] = "mix.quantise";
  return map;
}

/** Learn: bind the pending target to the message, replacing its old key. */
export function applyLearn(
  bindings: BindingMap,
  pendingTarget: string,
  eventKey: MidiEventKey,
): BindingMap {
  const next = { ...bindings };
  for (const [key, target] of Object.entries(next)) {
    if (target === pendingTarget) delete next[key];
  }
  delete next[eventKey];
  next[eventKey] = pendingTarget;
  return next;
}

export function unbindTarget(bindings: BindingMap, target: string): BindingMap {
  const next = { ...bindings };
  for (const [key, value] of Object.entries(next)) {
    if (value === target) delete next[key];
  }
  return next;
}
