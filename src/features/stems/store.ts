import { create } from "zustand";
import type { Track } from "@/shared/types";

interface StemsPanelState {
  track: Track | null;
  open: (track: Track) => void;
  close: () => void;
}

/** Opens the stem mixer for one track; null keeps the panel unmounted. */
export const useStemsPanelStore = create<StemsPanelState>((set) => ({
  track: null,
  open: (track) => set({ track }),
  close: () => set({ track: null }),
}));
