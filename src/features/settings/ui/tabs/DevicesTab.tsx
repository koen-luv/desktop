import { useTranslation } from "@/languages";
import Button from "@/shared/ui/Button";
import { CheckLine } from "@mingcute/react";
import { useDeviceControlStore } from "@/features/deviceControl";
import { discoverLocalDevices, connectToLocalHost } from "@/features/deviceControl";
import { disconnectController, sendControl } from "@/features/deviceControl";
import { startHosting, stopHosting } from "@/features/deviceControl";
import type { ControlAction } from "@/features/deviceControl";

function Spinner() {
  return (
    <span className="h-[14px] w-[14px] shrink-0 animate-spin rounded-full border-2 border-text-secondary border-t-transparent" />
  );
}

/**
 * Settings level-2 section for remote device control. Lets this device be
 * controlled by a phone (pairing code → remote) or control a paired computer
 * (enter their code → drive the queue/now-playing). Both live here so the
 * two-level settings menu stays within a single screen.
 */
export function DevicesTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const controllerPhase = useDeviceControlStore((s) => s.controllerPhase);
  const controllerError = useDeviceControlStore((s) => s.controllerError);
  const hostName = useDeviceControlStore((s) => s.hostName);
  const remote = useDeviceControlStore((s) => s.remote);
  const hostPhase = useDeviceControlStore((s) => s.hostPhase);
  const hostError = useDeviceControlStore((s) => s.hostError);
  const controllers = useDeviceControlStore((s) => s.controllers);
  const nearbyHosts = useDeviceControlStore((s) => s.nearbyHosts);
  const isDiscovering = useDeviceControlStore((s) => s.isDiscovering);
  const nearbyError = useDeviceControlStore((s) => s.nearbyError);

  const query = (searchQuery ?? "").trim().toLowerCase();
  const matches = (...texts: string[]) =>
    !query || texts.some((text) => text.toLowerCase().includes(query));

  const canHostLocally =
    typeof window !== "undefined" &&
    Boolean(window.linerElectron?.startLanHost && window.linerElectron?.onLanAnswer);
  const showController = matches(
    t("settings.devices.controller_title"),
    t("settings.devices.controller_desc"),
    "pair phone remote code",
  );
  const showHost = canHostLocally && matches(
    t("settings.devices.host_title"),
    t("settings.devices.host_desc"),
    "local wifi control from phone without a code",
  );

  const runControl = (action: ControlAction) => {
    sendControl(action);
  };

  const hostActive =
    hostPhase === "waiting" || hostPhase === "connecting" || hostPhase === "connected";

  if (!showController && !showHost) return null;

  return (
    <div className="flex flex-col">
      {/* ---- Controller: pair this device with another ---- */}
      {showController ? (
        <section className="flex flex-col gap-[10px] py-[13px]">
          <div className="flex min-w-0 max-w-[460px] flex-col gap-[2px]">
            <span className="text-text-primary text-[13px] font-[500] leading-snug">
              {t("settings.devices.controller_title")}
            </span>
            <span className="text-text-tertiary text-[12.5px] leading-relaxed">
              {t("settings.devices.controller_desc")}
            </span>
          </div>
          {controllerPhase === "connected" && hostName ? (
            <div className="flex flex-col gap-[10px]">
              <div className="flex items-center gap-[8px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[10px]">
                <CheckLine size={16} />
                <span className="text-[13px] text-text-secondary">
                  {t("devices.connected_to", { name: hostName })}
                </span>
              </div>
              <div className="flex gap-[8px]">
                <Button
                  variant="primary"
                  size="sm"
                  className="flex-1"
                  onClick={() => useDeviceControlStore.getState().setOpen(true)}
                >
                  {t("devices.open_remote")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  onClick={() => disconnectController()}
                >
                  {t("devices.disconnect")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-[8px]">
              <div className="flex flex-col gap-[7px] rounded-lg border border-border-primary bg-bg-primary p-[10px]">
                <div className="flex items-center justify-between gap-[8px]">
                  <span className="text-[12.5px] font-[500] text-text-secondary">
                    {t("devices.local_network") || "Same Wi-Fi network"}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isDiscovering}
                    onClick={() => void discoverLocalDevices()}
                  >
                    {isDiscovering
                      ? t("devices.searching") || "Searching…"
                      : t("devices.discover") || "Find devices"}
                  </Button>
                </div>
                {nearbyHosts.map((host) => (
                  <Button
                    key={`${host.address}:${host.port}`}
                    variant="outline"
                    size="sm"
                    disabled={controllerPhase === "connecting"}
                    onClick={() => void connectToLocalHost(host)}
                    className="w-full justify-start"
                  >
                    {host.name} · {host.address}
                  </Button>
                ))}
                {nearbyError ? (
                  <span className="text-[11.5px] text-text-tertiary">{nearbyError}</span>
                ) : null}
              </div>
              {controllerPhase === "connecting" ? (
                <div className="flex items-center gap-[9px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[11px]">
                  <Spinner />
                  <span className="text-[13px] text-text-secondary">
                    {t("devices.connecting_code")}
                  </span>
                </div>
              ) : null}
              {controllerError ? (
                <span className="text-[12px] text-[#E81123]">{controllerError}</span>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {/* ---- Host: let another device drive this player ---- */}
      {showHost ? (
        <section className="flex flex-col gap-[10px] py-[13px] border-t border-solid border-border-primary">
          <div className="flex min-w-0 max-w-[460px] flex-col gap-[2px]">
            <span className="text-text-primary text-[13px] font-[500] leading-snug">
              {t("settings.devices.host_title")}
            </span>
            <span className="text-text-tertiary text-[12.5px] leading-relaxed">
              {t("settings.devices.host_desc")}
            </span>
          </div>
          {hostActive ? (
            <div className="flex flex-col gap-[10px]">
              {hostPhase === "waiting" ? (
                <>
                  <span className="text-[12px] font-[500] text-text-secondary">
                    {t("devices.waiting_local") || "Waiting for a device on your Wi-Fi network"}
                  </span>
                </>
              ) : null}
              {hostPhase === "connected" ? (
                <div className="flex items-center gap-[8px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[10px]">
                  <CheckLine size={16} />
                  <span className="text-[13px] text-text-secondary">
                    {t("devices.controlled_by", {
                      name: controllers[0]?.name ?? t("devices.default_controller"),
                    })}
                  </span>
                </div>
              ) : null}
              {hostPhase === "connecting" ? (
                <div className="flex items-center gap-[9px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[11px]">
                  <Spinner />
                  <span className="text-[13px] text-text-secondary">
                    {t("devices.host_connecting")}
                  </span>
                </div>
              ) : null}
              <div>
                <Button variant="secondary" size="sm" onClick={() => stopHosting()}>
                  {t("devices.stop")}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button variant="secondary" size="sm" onClick={() => startHosting()}>
                {t("devices.allow_wifi") || "Enable local control"}
              </Button>
            </div>
          )}
          {hostError ? <span className="text-[12px] text-[#E81123]">{hostError}</span> : null}
        </section>
      ) : null}

      {/* ---- Already paired: quick transport without opening the remote sheet ---- */}
      {controllerPhase === "connected" && remote ? (
        <section className="flex flex-col gap-[8px] py-[13px] border-t border-solid border-border-primary">
          <span className="text-[12px] font-[500] text-text-secondary">
            {t("devices.live_controls_hint")}
          </span>
          <div className="flex gap-[8px]">
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={() => runControl({ a: "toggle" })}
            >
              {remote.playing ? t("devices.pause") : t("devices.play")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={() => runControl({ a: "prev" })}
            >
              {t("devices.previous")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              onClick={() => runControl({ a: "next" })}
            >
              {t("devices.next")}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
