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

interface TrafficCaptureControlProps {
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

  return (
    <>
      <div className="capture-control">
        <Toggle
          aria-label={LL.capture.modeAria({
            mode: LL.capture.systemProxy(),
            runtime: systemProxyEnabled ? LL.capture.running() : LL.capture.notRunning(),
            selection: systemProxySelected ? LL.capture.selected() : LL.capture.notSelected(),
          })}
          className="capture-mode-button"
          data-capture-state={getCaptureState(systemProxySelected, systemProxyEnabled)}
          disabled={disabled}
          onPressedChange={onSystemProxyChange}
          pressed={systemProxySelected}
          variant="outline"
        >
          <Desktop aria-hidden="true" data-icon="inline-start" weight="fill" />
          <span>{LL.capture.systemProxy()}</span>
        </Toggle>
        <Toggle
          aria-label={LL.capture.modeAria({
            mode: LL.capture.tun(),
            runtime: tunEnabled ? LL.capture.running() : LL.capture.notRunning(),
            selection: tunSelected ? LL.capture.selected() : LL.capture.notSelected(),
          })}
          className="capture-mode-button"
          data-capture-state={getCaptureState(tunSelected, tunEnabled)}
          disabled={disabled}
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
                {LL.capture.description()}
              </DialogDescription>
            </div>
          </div>
          <div className="capture-explanations">
            <section className="capture-explanation">
              <Desktop aria-hidden="true" />
              <div>
                <h2>{LL.capture.systemProxy()}</h2>
                <p>{LL.capture.systemProxyDescription()}</p>
              </div>
            </section>
            <section className="capture-explanation">
              <ShieldCheck aria-hidden="true" />
              <div>
                <h2>{LL.capture.tun()}</h2>
                <p>{LL.capture.tunDescription()}</p>
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
