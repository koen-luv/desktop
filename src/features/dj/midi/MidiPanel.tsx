import { memo, useMemo } from "react";
import { ASSIGNABLE_TARGETS, type BindingMap } from "./midiMap";
import type { UseMidiResult } from "./useMidi";

/**
 * MIDI mapping panel: device picker, learn rows grouped by control, and
 * template/reset actions. Opens as an overlay inside DJ mode.
 */

interface MidiPanelProps {
  midi: UseMidiResult;
  onClose: () => void;
}

const MidiPanel = memo(function MidiPanel({ midi, onClose }: MidiPanelProps) {
  const targetByMessage = useMemo(() => {
    const map = new Map<string, string>();
    for (const [message, target] of Object.entries(midi.bindings)) map.set(target, message);
    return map;
  }, [midi.bindings]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof ASSIGNABLE_TARGETS>();
    for (const target of ASSIGNABLE_TARGETS) {
      const list = byGroup.get(target.group) ?? [];
      list.push(target);
      byGroup.set(target.group, list);
    }
    return [...byGroup.entries()];
  }, []);

  return (
    <div className="absolute inset-0 z-[10] flex flex-col bg-bg-primary/98 backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-border-primary/60 px-4 py-3">
        <div className="flex items-center gap-3">
          <h3 className="m-0 text-[14px] font-[600]">MIDI controller</h3>
          <select
            aria-label="MIDI input"
            value={midi.selectedId ?? ""}
            onChange={(event) => midi.select(event.target.value || null)}
            disabled={!midi.supported || midi.devices.length === 0}
            className="h-[30px] max-w-[240px] rounded-[10px] border border-border-primary bg-bg-panel px-2 text-[12px]"
          >
            <option value="">No device</option>
            {midi.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-text-tertiary">
            {!midi.supported
              ? "Web MIDI is unavailable in this build"
              : midi.error
                ? midi.error
                : midi.connected
                  ? `connected${midi.lastMessage ? ` · last ${midi.lastMessage}` : ""}`
                  : midi.devices.length === 0
                    ? "no MIDI inputs found"
                    : "select a device"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={midi.applyTemplate}
            className="h-[30px] rounded-[10px] border border-border-primary px-3 text-[12px]"
          >
            Generic template
          </button>
          <button
            type="button"
            onClick={midi.resetBindings}
            className="h-[30px] rounded-[10px] border border-border-primary px-3 text-[12px] text-text-secondary"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-[30px] rounded-[10px] border border-border-primary px-3 text-[12px]"
          >
            Done
          </button>
        </div>
      </div>

      {midi.learnTarget ? (
        <div className="flex items-center justify-between gap-3 border-b border-border-primary/40 bg-accent-soft px-4 py-2 text-[12px]">
          <span>
            Learning <strong>{midi.learnTarget}</strong> — move a knob, fader or
            pad on the controller.
          </span>
          <button
            type="button"
            onClick={midi.cancelLearn}
            className="h-[26px] rounded-[8px] border border-border-primary px-2 text-[11px]"
          >
            Cancel
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {groups.map(([group, targets]) => (
          <section key={group} className="mb-4">
            <h4 className="m-0 mb-1 text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
              {group}
            </h4>
            <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
              {targets.map((target) => {
                const message = targetByMessage.get(target.id);
                const learning = midi.learnTarget === target.id;
                return (
                  <div
                    key={target.id}
                    className="flex items-center justify-between gap-2 border-b border-border-primary/30 py-[5px] text-[12px]"
                  >
                    <span className="min-w-0 truncate text-text-secondary">{target.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
                      {message ?? "—"}
                    </span>
                    <button
                      type="button"
                      onClick={() => (learning ? midi.cancelLearn() : midi.startLearn(target.id))}
                      className={`h-[22px] shrink-0 rounded-[6px] px-2 text-[10px] font-[600] ${
                        learning
                          ? "bg-accent-primary text-accent-ink"
                          : "border border-border-primary text-text-secondary"
                      }`}
                    >
                      {learning ? "Listening" : "Learn"}
                    </button>
                    {message ? (
                      <button
                        type="button"
                        aria-label={`Unbind ${target.id}`}
                        onClick={() => midi.unbind(target.id)}
                        className="h-[22px] w-[22px] shrink-0 rounded-[6px] border border-border-primary text-[10px] text-text-tertiary"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
});

export default MidiPanel;
