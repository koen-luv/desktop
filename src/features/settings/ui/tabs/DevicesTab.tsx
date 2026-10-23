import { useTranslation } from "@/languages";
import Button from "@/shared/ui/Button";
import { nativeCopy } from "@/platform";
import { showToast } from "@/shared/ui";
import { CheckLine, Copy2Line } from "@mingcute/react";
import { useDeviceControlStore } from "@/features/deviceControl";
import { connectToHost, disconnectController, sendControl } from "@/features/deviceControl";
import { startHosting, stopHosting } from "@/features/deviceControl";
import type { ControlAction } from "@/features/deviceControl";

const codeBoxClass =
  "w-full resize-none rounded-md border border-border-primary bg-bg-primary px-[12px] py-[10px] font-mono text-[12px] leading-[1.5] text-text-primary outline-none select-all";
const inputClass =
  "w-full resize-none rounded-md border border-border-primary bg-bg-primary px-[14px] py-[10px] font-mono text-[13px] text-text-primary placeholder:text-text-tertiary outline-none transition-[border-color] duration-150 focus:border-text-secondary";

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
  const codeInput = useDeviceControlStore((s) => s.codeInput);
  const setCodeInput = useDeviceControlStore((s) => s.setCodeInput);
  const controllerPhase = useDeviceControlStore((s) => s.controllerPhase);
  const controllerError = useDeviceControlStore((s) => s.controllerError);
  const hostName = useDeviceControlStore((s) => s.hostName);
  const remote = useDeviceControlStore((s) => s.remote);
  const hostPhase = useDeviceControlStore((s) => s.hostPhase);
  const hostCode = useDeviceControlStore((s) => s.hostCode);
  const hostError = useDeviceControlStore((s) => s.hostError);
  const controllers = useDeviceControlStore((s) => s.controllers);

  const query = (searchQuery ?? "").trim().toLowerCase();
  const matches = (...texts: string[]) =>
    !query || texts.some((text) => text.toLowerCase().includes(query));

  const showController = matches(
    t("settings.devices.controller_title"),
    t("settings.devices.controller_desc"),
    "pair phone remote code",
  );
  const showHost = matches(
    t("settings.devices.host_title"),
    t("settings.devices.host_desc"),
    "show code control from phone",
  );

  const start = async () => {
    await connectToHost(codeInput);
  };

  const copyHostCode = () => {
    if (!hostCode) return;
    const ok = nativeCopy(hostCode);
    showToast(ok ? t("party.copied") : t("party.copy_failed"), ok ? "checkmark" : "error");
  };

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
              {controllerPhase === "connecting" ? (
                <div className="flex items-center gap-[9px] rounded-lg border border-border-primary bg-bg-primary px-[12px] py-[11px]">
                  <Spinner />
                  <span className="text-[13px] text-text-secondary">
                    {t("devices.connecting_code")}
                  </span>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={6}
                    value={codeInput}
                    placeholder={t("devices.code_placeholder")}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
                      setCodeInput(digits);
                    }}
                    className={`${inputClass} tracking-[0.3em] text-center`}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    className="w-full"
                    onClick={() => void start()}
                  >
                    {t("devices.connect")}
                  </Button>
                </>
              )}
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
                    {t("devices.waiting")}
                  </span>
                  <textarea
                    readOnly
                    rows={2}
                    value={hostCode ?? ""}
                    onFocus={(e) => e.currentTarget.select()}
                    className={codeBoxClass}
                  />
                  <div className="flex gap-[8px]">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="flex-1"
                      onClick={() => copyHostCode()}
                    >
                      <Copy2Line size={14} />
                      {t("party.copy")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="flex-1"
                      onClick={() => startHosting()}
                    >
                      {t("settings.devices.new_code")}
                    </Button>
                  </div>
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
                {t("settings.devices.show_code")}
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
