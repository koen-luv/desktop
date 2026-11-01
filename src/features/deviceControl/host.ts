/**
 * Host side of remote device control: the PC (or any Liner instance running
 * the player) shows a six-digit code, waits for a controller to join through
 * a relay invite or same-network LAN discovery, then applies incoming control
 * commands and streams authoritative playback state back.
 */
import { createTranslatorSync, getStoredLocale } from "@/languages";
import { useAuthStore } from "@/features/auth";
import { usePlayerStore } from "@/features/player/store/playerStore";
import { playerEngine } from "@/features/player/engine/playerEngine";
import { PartyConnection } from "@/features/party/partySession";
import {
  closeRelayRoom,
  createRelayRoom,
  isAbortError,
  isPartyRelayEnabled,
  waitForRelayAnswer,
} from "@/features/party/partyRelay";
import {
  DEVICE_CHANNEL_LABEL,
  type ControlAction,
  type DeviceMessage,
  type DeviceStateMessage,
} from "./protocol";
import { useDeviceControlStore } from "./store/deviceControlStore";

const HEARTBEAT_MS = 5000;
const CONNECT_TIMEOUT_MS = 25_000;

let pendingId: string | null = null;
let relayCode: string | null = null;
let relayAbort: AbortController | null = null;
let openTimer: number | null = null;
let stopBroadcast: (() => void) | null = null;
let stopLocalAnswerListener: (() => void) | null = null;

function tr(key: string, vars?: Record<string, string | number>): string {
  return createTranslatorSync(getStoredLocale())(key, vars);
}

function ownName(): string {
  const user = useAuthStore.getState().user;
  return user?.displayName || user?.username || tr("devices.default_name");
}

function clearOpenTimer(): void {
  if (openTimer !== null) window.clearTimeout(openTimer);
  openTimer = null;
}

function clearRelay(): void {
  relayAbort?.abort();
  relayAbort = null;
  if (relayCode) {
    void closeRelayRoom(relayCode);
    relayCode = null;
  }
}

/** Full authoritative state — sent on connect, on change, and as a heartbeat. */
export function buildDeviceState(): DeviceStateMessage {
  const s = usePlayerStore.getState();
  const base = {
    t: "state" as const,
    trackId: s.currentTrack?.id ?? null,
    currentIndex: s.currentIndex,
    positionMs: s.positionMs,
    durationMs: s.durationMs,
    playing: s.status === "playing",
    playbackRate: s.playbackRate,
    volume: s.volume,
    repeat: s.repeat,
    shuffle: s.shuffle,
    sentAt: Date.now(),
  };
  if (!s.currentTrack) {
    return { ...base, track: undefined, queue: s.queue };
  }
  return {
    ...base,
    track: s.currentTrack,
    queue: s.queue,
    context: s.playbackContext,
    contextCover: s.playbackContextCover,
  };
}

function broadcastState(): void {
  const message = buildDeviceState();
  const store = useDeviceControlStore.getState();
  for (const conn of store.hostConnections.values()) {
    conn.send(message);
  }
}

function startBroadcast(): void {
  if (stopBroadcast) return;
  let disposed = false;
  const broadcast = () => {
    if (!disposed) broadcastState();
  };
  const unsubscribe = usePlayerStore.subscribe((state, prev) => {
    if (disposed) return;
    const trackChanged = state.currentTrack?.id !== prev.currentTrack?.id;
    const queueChanged = state.queue !== prev.queue;
    const transportChanged = state.status !== prev.status;
    const rateChanged = state.playbackRate !== prev.playbackRate;
    const volumeChanged = state.volume !== prev.volume;
    const modeChanged = state.repeat !== prev.repeat || state.shuffle !== prev.shuffle;
    const seeked =
      !trackChanged && state.status === prev.status && Math.abs(state.positionMs - prev.positionMs) > 1500;
    if (trackChanged || queueChanged || transportChanged || rateChanged || volumeChanged || modeChanged || seeked) {
      broadcast();
    }
  });
  broadcast();
  const heartbeat = window.setInterval(broadcast, HEARTBEAT_MS);
  stopBroadcast = () => {
    disposed = true;
    unsubscribe();
    window.clearInterval(heartbeat);
    stopBroadcast = null;
  };
}

// --- Host lifecycle ---------------------------------------------------------

/** Stop the host: tear the P2P link down and clear host state. */
export function stopHosting(): void {
  clearOpenTimer();
  clearRelay();
  stopLocalAnswerListener?.();
  stopLocalAnswerListener = null;
  void window.linerElectron?.stopLanHost?.();
  pendingId = null;
  stopBroadcast?.();
  const store = useDeviceControlStore.getState();
  for (const conn of store.hostConnections.values()) conn.close();
  store.resetHost();
}

/** Begin (or restart) hosting a device-control link. */
export function startHosting(): void {
  const store = useDeviceControlStore.getState();
  if (store.hostPhase === "creating" || store.hostPhase === "waiting" || store.hostPhase === "connecting") {
    return;
  }

  clearOpenTimer();
  clearRelay();
  pendingId = null;
  stopBroadcast?.();
  for (const conn of store.hostConnections.values()) conn.close();
  useDeviceControlStore.setState({
    hostPhase: "creating",
    hostCode: null,
    hostError: null,
    controllers: [],
    hostConnections: new Map(),
  });

  const electron = window.linerElectron;
  const hasLocalLanHost = Boolean(electron?.startLanHost && electron.onLanAnswer);
  if (!hasLocalLanHost && !isPartyRelayEnabled()) {
    useDeviceControlStore.setState({ hostPhase: "error", hostError: tr("devices.error_relay_disabled") });
    return;
  }

  const id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let conn: PartyConnection<DeviceMessage>;
  try {
    conn = new PartyConnection<DeviceMessage>(
      {
        onOpen: () => onControllerOpen(id),
        onMessage: (message) => onControllerMessage(id, message),
        onClose: () => onControllerClose(id),
      },
      true,
      DEVICE_CHANNEL_LABEL,
    );
  } catch {
    useDeviceControlStore.setState({ hostPhase: "error", hostError: tr("devices.error_unsupported") });
    return;
  }

  useDeviceControlStore.getState().hostConnections.set(id, conn);
  pendingId = id;

  void (async () => {
    try {
      const invite = await conn.createInviteCode();
      if (pendingId !== id) return;

      if (electron?.startLanHost && electron.onLanAnswer) {
        stopLocalAnswerListener?.();
        stopLocalAnswerListener = electron.onLanAnswer((answer) => {
          if (pendingId !== id) return;
          useDeviceControlStore.setState({ hostPhase: "connecting" });
          void conn.acceptAnswerCode(answer).then(() => {
            if (pendingId !== id) return;
            openTimer = window.setTimeout(() => {
              if (conn.isOpen) return;
              if (pendingId === id) pendingId = null;
              useDeviceControlStore.getState().hostConnections.delete(id);
              conn.close();
              useDeviceControlStore.setState({
                hostPhase: "error",
                hostError: tr("devices.error_timeout"),
              });
            }, CONNECT_TIMEOUT_MS);
          }).catch(() => {
            if (pendingId !== id) return;
            pendingId = null;
            conn.close();
            void electron.stopLanHost?.();
            useDeviceControlStore.setState({
              hostPhase: "error",
              hostError: tr("devices.error_connect_failed"),
            });
          });
        });

        const info = await electron.startLanHost(ownName(), invite);
        if (pendingId !== id) {
          stopLocalAnswerListener?.();
          stopLocalAnswerListener = null;
          void electron.stopLanHost?.();
          return;
        }
        useDeviceControlStore.setState({
          hostPhase: "waiting",
          hostCode: info.addresses.map((address) => `http://${address}:${info.port}`).join("\n"),
        });
        return;
      }

      const joinCode = await createRelayRoom(invite);
      if (pendingId !== id) {
        void closeRelayRoom(joinCode);
        return;
      }

      relayCode = joinCode;
      useDeviceControlStore.setState({ hostPhase: "waiting", hostCode: joinCode });

      const abort = new AbortController();
      relayAbort = abort;
      const answer = await waitForRelayAnswer(joinCode, abort.signal);
      if (pendingId !== id) return;

      useDeviceControlStore.setState({ hostPhase: "connecting" });
      await conn.acceptAnswerCode(answer);
      // The room has done its job — free it instead of waiting for expiry.
      clearRelay();

      openTimer = window.setTimeout(() => {
        if (conn.isOpen) return;
        if (pendingId === id) pendingId = null;
        const st = useDeviceControlStore.getState();
        st.hostConnections.delete(id);
        conn.close();
        useDeviceControlStore.setState({ hostPhase: "error", hostError: tr("devices.error_timeout") });
      }, CONNECT_TIMEOUT_MS);
    } catch (error) {
      if (isAbortError(error)) return;
      if (pendingId !== id) return;
      pendingId = null;
      useDeviceControlStore.getState().hostConnections.delete(id);
      conn.close();
      clearRelay();
      useDeviceControlStore.setState({ hostPhase: "error", hostError: tr("devices.error_invite_failed") });
    }
  })();
}

function onControllerOpen(id: string): void {
  clearOpenTimer();
  const store = useDeviceControlStore.getState();
  const conn = store.hostConnections.get(id);
  if (!conn) return;
  if (pendingId === id) pendingId = null;

  useDeviceControlStore.setState({
    hostPhase: "connected",
    hostError: null,
    controllers: [
      ...store.controllers.filter((c) => c.id !== id),
      { id, name: tr("devices.default_controller") },
    ],
  });
  conn.send({ t: "hello", name: ownName() });
  startBroadcast();
  broadcastState();
}

function onControllerMessage(id: string, message: DeviceMessage): void {
  const store = useDeviceControlStore.getState();
  const conn = store.hostConnections.get(id);
  if (!conn) return;

  if (message.t === "hello") {
    useDeviceControlStore.setState({
      controllers: store.controllers.map((c) => (c.id === id ? { ...c, name: message.name } : c)),
    });
    return;
  }
  if (message.t !== "ctl") return;
  applyControl(message.action);
}

function onControllerClose(id: string): void {
  clearOpenTimer();
  const store = useDeviceControlStore.getState();
  store.hostConnections.delete(id);
  const controllers = store.controllers.filter((c) => c.id !== id);
  const wasPending = pendingId === id;
  if (wasPending) pendingId = null;
  if (wasPending) {
    stopLocalAnswerListener?.();
    stopLocalAnswerListener = null;
    void window.linerElectron?.stopLanHost?.();
  }

  if (controllers.length === 0) stopBroadcast?.();
  useDeviceControlStore.setState({
    controllers,
    hostPhase: wasPending ? "error" : controllers.length === 0 ? "idle" : "connected",
    hostCode: controllers.length === 0 ? null : store.hostCode,
    hostError: wasPending ? tr("devices.error_connect_failed") : null,
  });
}

// --- Control application ----------------------------------------------------

/**
 * Map a controller's command onto the player engine. Every command is
 * user-initiated (unlike synced guest state), so the engine's playback-lock
 * guard applies — a host that is a party guest stays locked out.
 */
export function applyControl(action: ControlAction): void {
  switch (action.a) {
    case "toggle":
      void playerEngine.togglePlayPause();
      break;
    case "play":
      void playerEngine.resume();
      break;
    case "pause":
      playerEngine.pause();
      break;
    case "next":
      void playerEngine.skipNext();
      break;
    case "prev":
      void playerEngine.skipPrevious();
      break;
    case "seek":
      if (Number.isFinite(action.positionMs)) {
        playerEngine.seek(Math.max(0, action.positionMs));
      }
      break;
    case "volume":
      if (Number.isFinite(action.volume)) {
        playerEngine.setVolume(Math.min(1, Math.max(0, action.volume)));
      }
      break;
    case "jump": {
      const state = usePlayerStore.getState();
      const item = state.queue[action.index];
      if (!item || action.index === state.currentIndex) return;
      void playerEngine.playTrack(
        item,
        state.queue,
        state.playbackContext,
        state.playbackContextCover,
        action.index,
        true,
      );
      break;
    }
    case "move":
      playerEngine.reorderQueue(action.from, action.to);
      break;
    case "remove":
      playerEngine.removeFromQueue(action.index);
      break;
  }
}
