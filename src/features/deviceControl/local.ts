/**
 * Controller side of code-free LAN device control.
 *
 * Desktop: discovery + HTTP signaling go through the Electron main process.
 * Android: the native bridge broadcasts on the Wi-Fi and performs the HTTP
 * exchange (the WebView blocks cleartext HTTP). Both paths feed the same
 * PartyConnection, so the remote protocol is unchanged.
 */
import { createTranslatorSync, getStoredLocale } from "@/languages";
import { useAuthStore } from "@/features/auth";
import { PartyConnection } from "@/features/party/partySession";
import { getAndroidBridge, onNativeEvent } from "@/platform";
import {
  DEVICE_CHANNEL_LABEL,
  remoteFromState,
  type DeviceMessage,
} from "./protocol";
import { useDeviceControlStore, type LocalDeviceInfo } from "./store/deviceControlStore";

const DISCOVERY_TIMEOUT_MS = 4_000;
const CONNECT_TIMEOUT_MS = 20_000;

let connectTimer: number | null = null;

function tr(key: string, vars?: Record<string, string | number>): string {
  return createTranslatorSync(getStoredLocale())(key, vars);
}

function ownName(): string {
  const user = useAuthStore.getState().user;
  return user?.displayName || user?.username || tr("devices.default_name");
}

function newRequestId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clearConnectTimer(): void {
  if (connectTimer !== null) window.clearTimeout(connectTimer);
  connectTimer = null;
}

/** Broadcasts on the current Wi-Fi and returns the Liner desktops that answer. */
export async function discoverLocalDevices(): Promise<LocalDeviceInfo[]> {
  const store = useDeviceControlStore.getState();
  store.setDiscovering(true);
  store.setNearbyError(null);
  try {
    let hosts: LocalDeviceInfo[] = [];

    if (typeof window !== "undefined" && window.linerElectron?.discoverLanHosts) {
      hosts = await window.linerElectron.discoverLanHosts();
    } else {
      const bridge = getAndroidBridge();
      const lanDiscover = bridge?.lanDiscover;
      if (!bridge || !lanDiscover) {
        store.setNearbyError(tr("devices.error_local_unsupported"));
        return [];
      }
      const id = newRequestId("lan");
      hosts = await new Promise<LocalDeviceInfo[]>((resolve, reject) => {
        let settled = false;
        const finish = (value: LocalDeviceInfo[]) => {
          if (settled) return;
          settled = true;
          off();
          window.clearTimeout(timer);
          resolve(value);
        };
        const off = onNativeEvent("lanDiscovery", (payload) => {
          const data = payload as { id?: string; hosts?: LocalDeviceInfo[]; error?: string };
          if (data?.id !== id) return;
          if (data.error) {
            finishError(new Error(data.error));
            return;
          }
          finish(Array.isArray(data.hosts) ? data.hosts : []);
        });
        const finishError = (error: Error) => {
          if (settled) return;
          settled = true;
          off();
          window.clearTimeout(timer);
          reject(error);
        };
        const timer = window.setTimeout(() => finish([]), DISCOVERY_TIMEOUT_MS);
        try {
          lanDiscover.call(bridge, id);
        } catch {
          finishError(new Error(tr("devices.error_connect_failed")));
        }
      });
    }

    const unique = new Map<string, LocalDeviceInfo>();
    for (const host of hosts) {
      if (!host || typeof host.address !== "string" || typeof host.port !== "number") continue;
      unique.set(`${host.address}:${host.port}`, host);
    }
    const list = [...unique.values()];
    useDeviceControlStore.getState().setNearbyHosts(list);
    if (list.length === 0) {
      useDeviceControlStore.getState().setNearbyError(tr("devices.no_nearby"));
    }
    return list;
  } catch (error) {
    useDeviceControlStore.getState().setNearbyError(
      error instanceof Error ? error.message : tr("devices.no_nearby"),
    );
    return [];
  } finally {
    useDeviceControlStore.getState().setDiscovering(false);
  }
}

interface LanHttpResult {
  status: number;
  body: string;
}

/** HTTP to a discovered host, through whichever platform can reach it. */
async function lanHttp(url: string, method: "GET" | "POST", body?: string): Promise<LanHttpResult> {
  if (typeof window !== "undefined" && window.linerElectron?.discoverLanHosts) {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "text/plain" } : undefined,
      body,
    });
    return { status: response.status, body: await response.text() };
  }

  const bridge = getAndroidBridge();
  const lanRequest = bridge?.lanRequest;
  if (!bridge || !lanRequest) throw new Error("LAN control is unavailable on this platform");

  const id = newRequestId("lanreq");
  return new Promise<LanHttpResult>((resolve, reject) => {
    let settled = false;
    const finish = (action: "resolve" | "reject", value: LanHttpResult | Error) => {
      if (settled) return;
      settled = true;
      off();
      window.clearTimeout(timer);
      if (action === "resolve") resolve(value as LanHttpResult);
      else reject(value as Error);
    };
    const off = onNativeEvent("lanResponse", (payload) => {
      const data = payload as {
        id?: string;
        status?: number;
        body?: string;
        error?: string;
      };
      if (data?.id !== id) return;
      if (!data.status) finish("reject", new Error(data.error || "LAN request failed"));
      else finish("resolve", { status: data.status, body: data.body ?? "" });
    });
    const timer = window.setTimeout(
      () => finish("reject", new Error("LAN request timed out")),
      8_000,
    );
    try {
      lanRequest.call(bridge, id, method, url, body ?? null);
    } catch (error) {
      finish("reject", error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Connects this device to a discovered desktop and starts driving it. */
export async function connectToLocalHost(host: LocalDeviceInfo): Promise<void> {
  clearConnectTimer();
  const store = useDeviceControlStore.getState();
  store.controllerConnection?.close();
  useDeviceControlStore.setState({
    controllerPhase: "connecting",
    controllerError: null,
    hostName: host.name,
    remote: null,
    controllerConnection: null,
  });

  if (!host.token) {
    // Hosts from older versions do not issue a signaling key.
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_connect_failed"),
    });
    return;
  }

  const base = `http://${host.address}:${host.port}`;
  const key = `key=${encodeURIComponent(host.token)}`;
  let offer: string;
  try {
    const response = await lanHttp(`${base}/offer?${key}`, "GET");
    if (response.status !== 200) throw new Error(`offer ${response.status}`);
    const payload = JSON.parse(response.body) as { offer?: unknown; name?: unknown };
    if (typeof payload.offer !== "string" || !payload.offer) throw new Error("missing offer");
    offer = payload.offer;
    if (typeof payload.name === "string" && payload.name) {
      useDeviceControlStore.setState({ hostName: payload.name });
    }
  } catch (error) {
    useDeviceControlStore.setState({
      controllerPhase: "error",
      controllerError: tr("devices.error_connect_failed"),
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
    const response = await lanHttp(`${base}/answer?${key}`, "POST", answer);
    if (response.status !== 200) throw new Error(`answer ${response.status}`);

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
