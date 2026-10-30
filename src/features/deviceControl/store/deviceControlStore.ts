import { create } from "zustand";
import { PartyConnection } from "@/features/party/partySession";
import type { DeviceMessage, RemotePlayback } from "../protocol";

export type ControllerPhase = "idle" | "connecting" | "connected" | "error";
export type HostPhase =
  | "idle"
  | "creating"
  | "waiting"
  | "connecting"
  | "connected"
  | "error";

export interface DeviceControllerInfo {
  id: string;
  name: string;
}

export interface LocalDeviceInfo {
  name: string;
  address: string;
  port: number;
  token: string;
}

interface DeviceControlState {
  /** Whether the remote-control sheet is open. */
  open: boolean;

  // ---- Controller role (this device drives another player) ----
  controllerPhase: ControllerPhase;
  controllerError: string | null;
  hostName: string | null;
  remote: RemotePlayback | null;

  // ---- Host role (this device's playback is driven by a phone) ----
  hostPhase: HostPhase;
  hostCode: string | null;
  hostError: string | null;
  controllers: DeviceControllerInfo[];
  nearbyHosts: LocalDeviceInfo[];
  isDiscovering: boolean;
  nearbyError: string | null;

  setOpen: (open: boolean) => void;
  resetController: () => void;
  resetHost: () => void;
  setRemotePosition: (positionMs: number, sentAt?: number) => void;
  setRemotePlaying: (playing: boolean) => void;
  setRemoteVolume: (volume: number) => void;
  setNearbyHosts: (hosts: LocalDeviceInfo[]) => void;
  setDiscovering: (discovering: boolean) => void;
  setNearbyError: (error: string | null) => void;

  // Session objects live outside React state (RTCPeerConnection is mutable).
  hostConnections: Map<string, PartyConnection<DeviceMessage>>;
  controllerConnection: PartyConnection<DeviceMessage> | null;
}

const initial = {
  open: false,
  controllerPhase: "idle" as ControllerPhase,
  controllerError: null,
  hostName: null,
  remote: null,
  hostPhase: "idle" as HostPhase,
  hostCode: null,
  hostError: null,
  controllers: [] as DeviceControllerInfo[],
  nearbyHosts: [] as LocalDeviceInfo[],
  isDiscovering: false,
  nearbyError: null,
};

export const useDeviceControlStore = create<DeviceControlState>((set, get) => ({
  ...initial,
  hostConnections: new Map(),
  controllerConnection: null,

  setOpen: (open) => set({ open }),
  setNearbyHosts: (nearbyHosts) => set({ nearbyHosts }),
  setDiscovering: (isDiscovering) => set({ isDiscovering }),
  setNearbyError: (nearbyError) => set({ nearbyError }),

  setRemotePosition: (positionMs, sentAt) =>
    set((state) => {
      if (!state.remote) return state;
      return { remote: { ...state.remote, positionMs, sentAt: sentAt ?? Date.now() } };
    }),

  setRemotePlaying: (playing) =>
    set((state) => {
      if (!state.remote) return state;
      return { remote: { ...state.remote, playing, sentAt: Date.now() } };
    }),

  setRemoteVolume: (volume) =>
    set((state) => {
      if (!state.remote) return state;
      return { remote: { ...state.remote, volume } };
    }),

  resetController: () => {
    get().controllerConnection?.close();
    set({
      controllerPhase: "idle",
      controllerError: null,
      hostName: null,
      remote: null,
      controllerConnection: null,
    });
  },

  resetHost: () => {
    set({
      hostPhase: "idle",
      hostCode: null,
      hostError: null,
      controllers: [],
      hostConnections: new Map(),
    });
  },
}));
