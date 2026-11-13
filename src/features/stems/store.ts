import { create } from "zustand";
import type { Track } from "@/shared/types";
import { isStemSeparationAvailable } from "./api";

let probeInFlight: Promise<void> | null = null;

interface StemsPanelState {
  track: Track | null;
  /** null = not probed yet, true/false = server capability (desktop probe skipped). */
  available: boolean | null;
  open: (track: Track) => void;
  close: () => void;
  /** Probes the backend once; failures simply hide the menu entry. */
  probe: () => Promise<void>;
}

/** Opens the stem mixer for one track; null keeps the panel unmounted. */
export const useStemsPanelStore = create<StemsPanelState>((set, get) => ({
  track: null,
  available: null,
  open: (track) => set({ track }),
  close: () => set({ track: null }),
  probe: () => {
    if (get().available !== null) return Promise.resolve();
    if (probeInFlight) return probeInFlight;
    probeInFlight = isStemSeparationAvailable()
      .then((available) => set({ available }))
      .catch(() => set({ available: false }))
      .finally(() => {
        probeInFlight = null;
      });
    return probeInFlight;
  },
}));
