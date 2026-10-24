import { create } from "zustand";
import {
  PartyConnection,
  PartyMessage,
  type PartyRole,
} from "../partySession";

export type PartyPhase =
  | "idle"
  | "creating-invite"
  | "invite-ready"
  | "joining"
  | "answer-ready"
  | "connecting"
  | "connected"
  | "error";

export interface PartyGuestInfo {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

interface PartyState {
  /** Whether the party sheet dialog is open. */
  open: boolean;
  role: PartyRole | null;
  phase: PartyPhase;
  /** Host: the shareable invite code. Guest: the code they must send back. */
  code: string | null;
  /** Guest: the invite they pasted in (kept for display). */
  pendingInvite: string | null;
  /** Host: the reply textarea contents before submitting. */
  answerInput: string;
  /** Only guests with an open data channel — this count drives the host UI. */
  guests: PartyGuestInfo[];
  /** Guest: host and guest accounts currently connected to the party. */
  connectedAccounts: PartyGuestInfo[];
  error: string | null;
  /** Host: whether guests may edit the queue. Guest: last value received. */
  allowGuestQueueControl: boolean;

  setOpen: (open: boolean) => void;
  setAnswerInput: (value: string) => void;
  reset: () => void;

  // Session objects live outside React state (RTCPeerConnection is mutable).
  hostConnections: Map<string, PartyConnection>;
  guestConnection: PartyConnection | null;
  messageHandlers: Set<(message: PartyMessage) => void>;

  emitMessage: (message: PartyMessage) => void;
  subscribeMessages: (
    fn: (message: PartyMessage) => void,
  ) => () => void;
}

const initialState = {
  open: false,
  role: null,
  phase: "idle" as PartyPhase,
  code: null,
  pendingInvite: null,
  answerInput: "",
  guests: [] as PartyGuestInfo[],
  connectedAccounts: [] as PartyGuestInfo[],
  error: null,
  allowGuestQueueControl: false,
};

export const usePartyStore = create<PartyState>((set, get) => ({
  ...initialState,

  hostConnections: new Map(),
  guestConnection: null,
  messageHandlers: new Set(),

  setOpen: (open) => set({ open }),
  setAnswerInput: (value) => set({ answerInput: value }),

  reset: () => {
    const state = get();
    for (const conn of state.hostConnections.values()) conn.close();
    state.guestConnection?.close();
    set({
      ...initialState,
      // Keep the sheet itself open so the caller decides what the user sees.
      open: state.open,
      hostConnections: new Map(),
      guestConnection: null,
    });
  },

  emitMessage: (message) => {
    for (const fn of get().messageHandlers) fn(message);
  },

  subscribeMessages: (fn) => {
    get().messageHandlers.add(fn);
    return () => {
      get().messageHandlers.delete(fn);
    };
  },
}));
