/** Controller-side actions for an already discovered local host. */
import { createTranslatorSync, getStoredLocale } from "@/languages";
import { useAuthStore } from "@/features/auth";
import { PartyConnection } from "@/features/party/partySession";
import {
  fetchRelayOffer,
  isPartyRelayEnabled,
  normalizeJoinCode,
  submitRelayAnswer,
} from "@/features/party/partyRelay";
import {
  DEVICE_CHANNEL_LABEL,
  remoteFromState,
  type ControlAction,
  type DeviceMessage,
} from "./protocol";
import { useDeviceControlStore } from "./store/deviceControlStore";

const CONNECT_TIMEOUT_MS = 25_000;

let connectTimer: number | null = null;

function tr(key: string, vars?: Record<string, string | number>): string {
  return createTranslatorSync(getStoredLocale())(key, vars);
}

function ownName(): string {
  const user = useAuthStore.getState().user;
  return user?.displayName || user?.username || tr("devices.default_name");
}

function clearConnectTimer(): void {
  if (connectTimer !== null) window.clearTimeout(connectTimer);
  connectTimer = null;
}

/** Controller: disconnect and clear the remote session. */
export function disconnectController(): void {
  clearConnectTimer();
  const store = useDeviceControlStore.getState();
  const conn = store.controllerConnection;
  useDeviceControlStore.setState({ controllerConnection: null });
  conn?.close();
  store.resetController();
}

/** Controller: send one command to the host. */
export function sendControl(action: ControlAction): void {
  const store = useDeviceControlStore.getState();
  if (store.controllerPhase !== "connected") return;
  store.controllerConnection?.send({ t: "ctl", action });
}

/**
 * Controller: join a computer by the six-digit code it shows.
 *
 * LAN discovery only works when the phone can reach the desktop directly, so
 * this is the path that always works — the code is just a relay room key for
 * the WebRTC offer/answer exchange.
 */
export async function connectToHostCode(input: string): Promise<void> {
  const store = useDeviceControlStore.getState();
  if (store.controllerPhase === "connecting") return;

  const code = normalizeJoinCode(input);
  if (!code) {
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_invalid_code"),
    });
    return;
  }
  if (!isPartyRelayEnabled()) {
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_relay_disabled"),
    });
    return;
  }

  clearConnectTimer();
  store.controllerConnection?.close();
  useDeviceControlStore.setState({
    controllerPhase: "connecting",
    controllerError: null,
    hostName: null,
    remote: null,
    controllerConnection: null,
  });

  let offer: string;
  try {
    offer = await fetchRelayOffer(code);
  } catch {
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_code_not_found"),
    });
    return;
  }

  let conn: PartyConnection<DeviceMessage>;
  try {
    conn = new PartyConnection<DeviceMessage>(
      {
        onOpen: () => {
          clearConnectTimer();
          conn.send({ t: "hello", name: ownName() });
          useDeviceControlStore.setState({
            controllerPhase: "connected",
            controllerError: null,
          });
        },
        onMessage: (message) => {
          if (message.t === "state") {
            useDeviceControlStore.setState({ remote: remoteFromState(message) });
          } else if (message.t === "hello") {
            useDeviceControlStore.setState({ hostName: message.name });
          }
        },
        onClose: (reason) => {
          if (reason === "local") return;
          clearConnectTimer();
          useDeviceControlStore.setState({
            controllerPhase: "error",
            controllerError: tr(
              reason === "failed" ? "devices.error_connect_failed" : "devices.error_host_left",
            ),
            controllerConnection: null,
            remote: null,
          });
        },
      },
      false,
      DEVICE_CHANNEL_LABEL,
    );
  } catch {
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_unsupported"),
    });
    return;
  }

  useDeviceControlStore.setState({ controllerConnection: conn });

  try {
    const answer = await conn.createAnswerCode(offer);
    await submitRelayAnswer(code, answer);

    connectTimer = window.setTimeout(() => {
      if (conn.isOpen) return;
      conn.close();
      useDeviceControlStore.setState({
        controllerPhase: "error",
        controllerError: tr("devices.error_timeout"),
        controllerConnection: null,
        remote: null,
      });
    }, CONNECT_TIMEOUT_MS);
  } catch {
    conn.close();
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_connect_failed"),
      controllerConnection: null,
      remote: null,
    });
  }
}
