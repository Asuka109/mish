import { Desktop } from "@phosphor-icons/react/Desktop";
import { Question } from "@phosphor-icons/react/Question";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Toggle,
} from "@mish/ui";
import { useI18nContext } from "../i18n/i18n-react";
import type {
  CapabilityAvailability,
  CaptureRecoveryAction,
  PlatformCapabilitiesDto,
  StatusAdapterKind,
  SystemProxyRuntimeStatusDto,
  TunRuntimeStatusDto,
} from "@mish/contracts";
import {
  getCaptureModeDescriptionId,
  isCaptureCapabilityAvailable,
} from "../data/status-capabilities";

interface TrafficCaptureControlProps {
  adapterKind: StatusAdapterKind;
  capabilities: PlatformCapabilitiesDto;
  commandSupported: boolean;
  disabled?: boolean;
  onSystemProxyRecovery(action: CaptureRecoveryAction): void;
  onSystemProxyChange(value: boolean): void;
  onTunChange(value: boolean): void;
  pending?: boolean;
  systemProxyEnabled: boolean;
  systemProxySelected: boolean;
  systemProxyStatus: SystemProxyRuntimeStatusDto;
  tunEnabled: boolean;
  tunSelected: boolean;
  tunStatus: TunRuntimeStatusDto;
}

function getCaptureState(selected: boolean, enabled: boolean) {
  if (enabled) return "running";
  if (selected) return "remembered";
  return "unselected";
}

export function TrafficCaptureControl({
  adapterKind,
  capabilities,
  commandSupported,
  disabled = false,
  onSystemProxyChange,
  onSystemProxyRecovery,
  onTunChange,
  pending = false,
  systemProxyEnabled,
  systemProxySelected,
  systemProxyStatus,
  tunEnabled,
  tunSelected,
  tunStatus,
}: TrafficCaptureControlProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const { LL } = useI18nContext();
  const systemProxyAvailable = isCaptureCapabilityAvailable(adapterKind, capabilities.systemProxy);
  const tunAvailable = isCaptureCapabilityAvailable(adapterKind, capabilities.tun);

  function systemProxyStatusMessage() {
    if (systemProxyStatus.phase === "drift") {
      if (systemProxyStatus.failure === "invalid-recovery") {
        return LL.capture.systemProxyInvalidRecovery();
      }
      if (systemProxyStatus.failure === "persistence-failed") {
        return LL.capture.systemProxyPersistenceFailure();
      }
      return LL.capture.systemProxyDrift();
    }
    if (systemProxyStatus.phase === "failed") {
      if (systemProxyStatus.failure === "permission-denied") {
        return LL.capture.systemProxyPermissionFailure();
      }
      if (systemProxyStatus.failure === "unsafe-existing-configuration") {
        return LL.capture.systemProxyUnsafeFailure();
      }
      if (systemProxyStatus.failure === "core-unhealthy") {
        return LL.capture.systemProxyCoreFailure();
      }
      if (systemProxyStatus.failure === "invalid-recovery") {
        return LL.capture.systemProxyInvalidRecovery();
      }
      if (systemProxyStatus.failure === "persistence-failed") {
        return LL.capture.systemProxyPersistenceFailure();
      }
      return LL.capture.systemProxyFailure();
    }
    if (pending || systemProxyStatus.phase === "pending") {
      return LL.capture.systemProxyPending();
    }
    if (systemProxyStatus.phase === "applied") return LL.capture.systemProxyApplied();
    if (systemProxyStatus.observed === "other" || systemProxyStatus.observed === "mish") {
      return LL.capture.systemProxyLeftAsIs();
    }
    if (systemProxyStatus.observed === "unknown") return LL.capture.systemProxyUnknown();
    return LL.capture.systemProxyOff();
  }

  function getHelpDescription(mode: "systemProxy" | "tun", availability: CapabilityAvailability) {
    if (adapterKind === "fixture") {
      return mode === "systemProxy"
        ? LL.capture.systemProxyFixtureDescription()
        : LL.capture.tunFixtureDescription();
    }
    if (availability === "permission-required") {
      return mode === "systemProxy"
        ? LL.capabilities.systemProxyPermission()
        : LL.capabilities.tunPermission();
    }
    if (!isCaptureCapabilityAvailable(adapterKind, availability)) {
      return mode === "systemProxy"
        ? LL.capabilities.systemProxyUnavailable()
        : LL.capabilities.tunUnavailable();
    }
    if (!commandSupported) return LL.capabilities.localActionUnavailable();
    return mode === "systemProxy"
      ? LL.capture.systemProxyDescription()
      : LL.capture.tunDescription();
  }

  function tunStatusMessage() {
    if (tunStatus.phase === "drift") return LL.capture.tunDrift();
    if (tunStatus.phase === "failed") return LL.capture.tunFailure();
    if (pending || tunStatus.phase === "pending") return LL.capture.tunPending();
    if (tunStatus.phase === "applied") return LL.capture.tunApplied();
    return LL.capture.tunOff();
  }

  return (
    <>
      <div className="traffic-capture-stack">
        <div className="capture-control">
          <Toggle
            aria-describedby={getCaptureModeDescriptionId(
              adapterKind,
              capabilities.systemProxy,
              commandSupported,
              "systemProxy",
            )}
            aria-label={LL.capture.modeAria({
              mode: LL.capture.systemProxy(),
              runtime: systemProxyEnabled ? LL.capture.running() : LL.capture.notRunning(),
              selection: systemProxySelected ? LL.capture.selected() : LL.capture.notSelected(),
            })}
            className="capture-mode-button"
            data-capture-state={getCaptureState(systemProxySelected, systemProxyEnabled)}
            disabled={disabled || !commandSupported || !systemProxyAvailable}
            onPressedChange={onSystemProxyChange}
            pressed={systemProxySelected}
            variant="outline"
          >
            <Desktop aria-hidden="true" data-icon="inline-start" weight="fill" />
            <span>{LL.capture.systemProxy()}</span>
          </Toggle>
          <Toggle
            aria-describedby={getCaptureModeDescriptionId(
              adapterKind,
              capabilities.tun,
              commandSupported,
              "tun",
            )}
            aria-label={LL.capture.modeAria({
              mode: LL.capture.tun(),
              runtime: tunEnabled ? LL.capture.running() : LL.capture.notRunning(),
              selection: tunSelected ? LL.capture.selected() : LL.capture.notSelected(),
            })}
            className="capture-mode-button"
            data-capture-state={getCaptureState(tunSelected, tunEnabled)}
            disabled={disabled || !commandSupported || !tunAvailable}
            onPressedChange={onTunChange}
            pressed={tunSelected}
            variant="outline"
          >
            <ShieldCheck aria-hidden="true" data-icon="inline-start" weight="fill" />
            <span>{LL.capture.tun()}</span>
          </Toggle>
          <Button
            aria-label={LL.capture.helpAria()}
            className="capture-help-button"
            onClick={() => setHelpOpen(true)}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <Question aria-hidden="true" />
          </Button>
        </div>
        {adapterKind === "fixture" ? null : (
          <div
            className="system-proxy-reconciliation"
            data-phase={
              systemProxyStatus.phase === "drift" || systemProxyStatus.phase === "failed"
                ? systemProxyStatus.phase
                : pending
                  ? "pending"
                  : systemProxyStatus.phase
            }
            role={
              systemProxyStatus.phase === "drift" || systemProxyStatus.phase === "failed"
                ? "alert"
                : pending || systemProxyStatus.phase === "pending"
                  ? "status"
                  : undefined
            }
          >
            <p>{systemProxyStatusMessage()}</p>
            <p>{tunStatusMessage()}</p>
            {systemProxyStatus.recoveryActions.length > 0 ? (
              <div className="system-proxy-recovery-actions">
                {systemProxyStatus.recoveryActions.includes("repair") ? (
                  <Button
                    disabled={pending}
                    onClick={() => onSystemProxyRecovery("repair")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {LL.capture.repairSystemProxy()}
                  </Button>
                ) : null}
                {systemProxyStatus.recoveryActions.includes("leave-as-is") ? (
                  <Button
                    disabled={pending}
                    onClick={() => onSystemProxyRecovery("leave-as-is")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {LL.capture.leaveAsIs()}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <Dialog onOpenChange={setHelpOpen} open={helpOpen}>
        <DialogContent className="info-dialog" closeLabel={LL.common.close()}>
          <div className="dialog-header">
            <div>
              <DialogTitle className="dialog-title">{LL.capture.title()}</DialogTitle>
              <DialogDescription className="dialog-description">
                {adapterKind === "fixture"
                  ? LL.capture.fixtureDescription()
                  : adapterKind === "rpc"
                    ? LL.capture.desktopDescription()
                    : LL.capture.deviceDescription()}
              </DialogDescription>
            </div>
          </div>
          <div className="capture-explanations">
            <section className="capture-explanation">
              <Desktop aria-hidden="true" />
              <div>
                <h2>{LL.capture.systemProxy()}</h2>
                <p>{getHelpDescription("systemProxy", capabilities.systemProxy)}</p>
              </div>
            </section>
            <section className="capture-explanation">
              <ShieldCheck aria-hidden="true" />
              <div>
                <h2>{LL.capture.tun()}</h2>
                <p>{getHelpDescription("tun", capabilities.tun)}</p>
              </div>
            </section>
          </div>
          <div className="dialog-footer">
            <DialogClose
              render={<Button className="secondary-button" type="button" variant="outline" />}
            >
              {LL.capture.acknowledge()}
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
