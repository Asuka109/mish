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
} from "@mihomo/ui";
import { useI18nContext } from "../i18n/i18n-react";

interface TrafficCaptureControlProps {
  onSystemProxyChange(value: boolean): void;
  onTunChange(value: boolean): void;
  systemProxyEnabled: boolean;
  tunEnabled: boolean;
}

export function TrafficCaptureControl({
  onSystemProxyChange,
  onTunChange,
  systemProxyEnabled,
  tunEnabled,
}: TrafficCaptureControlProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const { LL } = useI18nContext();

  return (
    <>
      <div className="capture-control">
        <Toggle
          className="capture-mode-button"
          onPressedChange={onSystemProxyChange}
          pressed={systemProxyEnabled}
          variant="outline"
        >
          <Desktop aria-hidden="true" data-icon="inline-start" weight="fill" />
          <span>{LL.capture.systemProxy()}</span>
        </Toggle>
        <Toggle
          className="capture-mode-button"
          onPressedChange={onTunChange}
          pressed={tunEnabled}
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
