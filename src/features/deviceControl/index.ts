export { useDeviceControlStore } from "./store/deviceControlStore";
export { startHosting, stopHosting, applyControl, buildDeviceState } from "./host";
export { connectToHost, disconnectController, sendControl } from "./controller";
export { DEVICE_CHANNEL_LABEL } from "./protocol";
export { remoteFromState, remotePositionMs } from "./protocol";
export { default as DeviceControlSheet } from "./ui/DeviceControlSheet";
export type { ControlAction, DeviceMessage, DeviceStateMessage, RemotePlayback } from "./protocol";
export type { ControllerPhase, DeviceControllerInfo, HostPhase } from "./store/deviceControlStore";
