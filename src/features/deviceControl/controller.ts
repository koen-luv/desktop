/** Controller-side actions for an already discovered local host. */
import type { ControlAction } from "./protocol";
import { useDeviceControlStore } from "./store/deviceControlStore";

/** Controller: disconnect and clear the remote session. */
export function disconnectController(): void {
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
