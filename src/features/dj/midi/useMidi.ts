import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyLearn,
  genericTemplate,
  parseMidiMessage,
  resolveAction,
  unbindTarget,
  type BindingMap,
  type DeckSide,
  type DjAction,
} from "./midiMap";

/**
 * Web MIDI bridge for DJ mode.
 *
 * Enumerates class-compliant MIDI inputs, routes messages through the binding
 * map into DJ actions, and supports learn mode (move a control, then click
 * Learn and move it again). Bindings persist per device name in localStorage,
 * so a controller keeps its map across sessions and the generic template is a
 * starting point rather than a hard-coded assumption about specific hardware.
 */

const STORAGE_KEY = "liner_dj_midi_bindings_v1";

type SavedMaps = Record<string, BindingMap>;

function readSavedMaps(): SavedMaps {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedMaps) : {};
  } catch {
    return {};
  }
}

function writeSavedMaps(maps: SavedMaps): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(maps));
  } catch {
    // private mode: the mapping lasts for this session only
  }
}

export interface MidiDevice {
  id: string;
  name: string;
}

export interface UseMidiResult {
  supported: boolean;
  error: string | null;
  devices: MidiDevice[];
  selectedId: string | null;
  select: (id: string | null) => void;
  connected: boolean;
  bindings: BindingMap;
  learnTarget: string | null;
  startLearn: (target: string) => void;
  cancelLearn: () => void;
  unbind: (target: string) => void;
  applyTemplate: () => void;
  resetBindings: () => void;
  lastMessage: string | null;
}

export function useMidi(options: {
  focused: DeckSide;
  onAction: (action: DjAction) => void;
}): UseMidiResult {
  const { focused, onAction } = options;
  const supported =
    typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;

  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MidiDevice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [bindings, setBindings] = useState<BindingMap>({});
  const [learnTarget, setLearnTarget] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);

  // Latest closures without re-subscribing MIDI handlers.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const learnRef = useRef<string | null>(null);
  learnRef.current = learnTarget;
  const deviceNameRef = useRef<string | null>(null);
  const accessRef = useRef<MIDIAccess | null>(null);
  const inputRef = useRef<MIDIInput | null>(null);

  const persistCurrent = useCallback((map: BindingMap) => {
    const name = deviceNameRef.current;
    if (!name) return;
    const saved = readSavedMaps();
    saved[name] = map;
    writeSavedMaps(saved);
  }, []);

  const handleMessage = useCallback(
    (event: MIDIMessageEvent) => {
      if (!event.data) return;
      const parsed = parseMidiMessage(new Uint8Array(event.data));
      if (!parsed) return;
      setLastMessage(parsed.key);

      const pending = learnRef.current;
      if (pending) {
        setLearnTarget(null);
        setBindings((prev) => {
          const next = applyLearn(prev, pending, parsed.key);
          persistCurrent(next);
          return next;
        });
        return;
      }
      const action = resolveAction(parsed, bindingsRef.current, focusedRef.current);
      if (action) onActionRef.current(action);
    },
    [persistCurrent],
  );

  const attach = useCallback(
    (access: MIDIAccess, id: string | null) => {
      if (inputRef.current) inputRef.current.onmidimessage = null;
      setConnected(false);
      if (!id) {
        deviceNameRef.current = null;
        setBindings({});
        return;
      }
      const input = access.inputs.get(id);
      if (!input) return;
      input.onmidimessage = handleMessage;
      inputRef.current = input;
      deviceNameRef.current = input.name ?? id;
      const saved = readSavedMaps();
      const existing = saved[deviceNameRef.current];
      setBindings(existing ?? genericTemplate());
      if (!existing && deviceNameRef.current) {
        saved[deviceNameRef.current] = genericTemplate();
        writeSavedMaps(saved);
      }
      setConnected(true);
    },
    [handleMessage],
  );

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    const refresh = (access: MIDIAccess) => {
      const list: MidiDevice[] = [];
      access.inputs.forEach((input) => {
        list.push({ id: input.id, name: input.name ?? input.id });
      });
      setDevices(list);
      setSelectedId((current) => {
        if (current && list.some((device) => device.id === current)) return current;
        return list.length === 1 ? list[0].id : null;
      });
    };

    navigator
      .requestMIDIAccess({ sysex: false })
      .then((access) => {
        if (disposed) return;
        accessRef.current = access;
        access.onstatechange = () => refresh(access);
        refresh(access);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error
            ? `MIDI access failed: ${err.message}`
            : "MIDI access was denied.",
        );
      });

    return () => {
      disposed = true;
      if (inputRef.current) inputRef.current.onmidimessage = null;
      if (accessRef.current) accessRef.current.onstatechange = null;
    };
  }, [supported]);

  useEffect(() => {
    if (accessRef.current) attach(accessRef.current, selectedId);
  }, [attach, selectedId]);

  const updateBindings = useCallback(
    (next: BindingMap) => {
      setBindings(next);
      persistCurrent(next);
    },
    [persistCurrent],
  );

  return {
    supported,
    error,
    devices,
    selectedId,
    select: setSelectedId,
    connected,
    bindings,
    learnTarget,
    startLearn: setLearnTarget,
    cancelLearn: () => setLearnTarget(null),
    unbind: (target) => updateBindings(unbindTarget(bindings, target)),
    applyTemplate: () => updateBindings(genericTemplate()),
    resetBindings: () => updateBindings({}),
    lastMessage,
  };
}
