export { useDeviceControlStore } from "./store/deviceControlStore";
export { startHosting, stopHosting, applyControl, buildDeviceState } from "./host";
export { connectToHost, disconnectController, sendControl } from "./controller";
export { discoverLocalDevices, connectToLocalHost } from "./local";
export { DEVICE_CHANNEL_LABEL } from "./protocol";
export { remoteFromState, remotePositionMs } from "./protocol";
export { default as DeviceControlSheet } from "./ui/DeviceControlSheet";
export type { ControlAction, DeviceMessage, DeviceStateMessage, RemotePlayback } from "./protocol";
export type { ControllerPhase, DeviceControllerInfo, HostPhase, LocalDeviceInfo } from "./store/deviceControlStore";
