/**
 * Controller side of remote device control: joins the six-digit code a
 * host device (usually the PC) is showing, then listens for authoritative
 * state and sends control commands back.
 */
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

/** Controller: join a host showing `input` and start driving it. */
export async function connectToHost(input: string): Promise<void> {
  clearConnectTimer();
  const store = useDeviceControlStore.getState();
  store.controllerConnection?.close();

  const code = normalizeJoinCode(input);
  useDeviceControlStore.setState({
    controllerPhase: "connecting",
    controllerError: null,
    hostName: null,
    remote: null,
    controllerConnection: null,
  });

  if (!isPartyRelayEnabled()) {
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_relay_disabled"),
    });
    return;
  }
  if (!code) {
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_invalid_code"),
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
          useDeviceControlStore.setState({
            controllerPhase: "error",
            controllerError: tr(reason === "failed" ? "devices.error_connect_failed" : "devices.error_host_left"),
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
    const invite = await fetchRelayOffer(code);
    const answer = await conn.createAnswerCode(invite);
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
      controllerError: tr("devices.error_invalid_code"),
      controllerConnection: null,
      remote: null,
    });
  }
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
