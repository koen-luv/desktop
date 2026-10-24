import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { debouncedStorage } from "@/shared/utils/storage";
import {
  DEFAULT_EQUALIZER_GAINS,
  normalizeEqualizerGains,
} from "../engine/equalizer";

interface EqualizerSettingsState {
  enabled: boolean;
  gains: number[];
  setEnabled: (enabled: boolean) => void;
  setGain: (index: number, gain: number) => void;
  setGains: (gains: unknown) => void;
}

export const useEqualizerSettingsStore = create<EqualizerSettingsState>()(
  persist(
    (set) => ({
      enabled: false,
      gains: [...DEFAULT_EQUALIZER_GAINS],
      setEnabled: (enabled) => set({ enabled }),
      setGain: (index, gain) =>
        set((state) => {
          if (!Number.isInteger(index) || index < 0 || index >= state.gains.length) {
            return state;
          }
          const gains = [...state.gains];
          gains[index] = gain;
          return { gains: normalizeEqualizerGains(gains) };
        }),
      setGains: (gains) => set({ gains: normalizeEqualizerGains(gains) }),
    }),
    {
      name: "liner_equalizer_settings_v1",
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (state) => ({ enabled: state.enabled, gains: state.gains }),
      merge: (persisted, current) => {
        const saved =
          persisted && typeof persisted === "object"
            ? (persisted as Partial<EqualizerSettingsState>)
            : {};
        return {
          ...current,
          enabled: typeof saved.enabled === "boolean" ? saved.enabled : current.enabled,
          gains: normalizeEqualizerGains(saved.gains),
        };
      },
    },
  ),
);
