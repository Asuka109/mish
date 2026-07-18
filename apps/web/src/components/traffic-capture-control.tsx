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
  PlatformCapabilitiesDto,
  StatusAdapterKind,
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
  onSystemProxyChange(value: boolean): void;
  onTunChange(value: boolean): void;
  systemProxyEnabled: boolean;
  systemProxySelected: boolean;
  tunEnabled: boolean;
  tunSelected: boolean;
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
  onTunChange,
  systemProxyEnabled,
  systemProxySelected,
  tunEnabled,
  tunSelected,
}: TrafficCaptureControlProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const { LL } = useI18nContext();
  const systemProxyAvailable = isCaptureCapabilityAvailable(adapterKind, capabilities.systemProxy);
  const tunAvailable = isCaptureCapabilityAvailable(adapterKind, capabilities.tun);

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

  return (
    <>
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
