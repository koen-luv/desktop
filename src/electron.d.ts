import type { NeritiumElectronApi } from "../electron/preload";

declare global {
  interface Window {
    neritiumElectron?: NeritiumElectronApi;
  }
}

export {};
