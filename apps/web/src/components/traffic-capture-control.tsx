import { Desktop } from "@phosphor-icons/react/Desktop";
import { Question } from "@phosphor-icons/react/Question";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { cx, tv } from "@mish/ui/tv";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  Toggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mish/ui";
import { useI18nContext } from "../i18n/i18n-react";
import type {
  CapabilityAvailability,
  PlatformCapabilitiesDto,
  StatusAdapterKind,
  SystemProxyRuntimeStatusDto,
  TunRuntimeStatusDto,
} from "@mish/contracts";
import type { TunHelperOperationResult } from "../data/settings-provider";
import type { CaptureActionFeedback } from "../data/capture-command";
import {
  getCaptureModeDescriptionId,
  isCaptureCapabilityAvailable,
  statusDescriptionIds,
} from "../data/status-capabilities";
import { systemProxyStatusMessage, tunStatusMessage } from "../data/capture-status-message";

const captureStyles = tv({
  slots: {
    stack: "traffic-capture-stack flex min-w-0 flex-col items-start gap-1.5 py-2.5",
    control: "inline-flex flex-wrap items-center gap-2",
    dialogHeader: "border-0",
    explanations: "px-4 py-1.5",
    explanation: cx(
      "grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 py-3.5 [&>svg]:mt-px [&>svg]:size-4.5",
      "[&>svg]:text-muted-foreground [&_p]:mt-1 [&_p]:text-metadata [&_p]:leading-5",
      "[&_p]:text-muted-foreground",
    ),
    guideExplanation: "grid grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5 py-3.5",
    guideIcon: "mt-px size-4.5 text-muted-foreground",
    guideHeaderCopy: "flex w-full min-w-0 flex-col",
    guideCopy: "flex min-w-0 flex-col items-start gap-1",
    guideTitle: "m-0 text-body font-semibold text-fg",
    guideDescription: "m-0 text-metadata leading-5 text-muted-foreground",
    dialogFooter: "border-0",
    guideDialogFooter: "border-0 max-dialog-compact:flex-wrap",
  },
});

interface TrafficCaptureControlProps {
  adapterKind: StatusAdapterKind;
  capabilities: PlatformCapabilitiesDto;
  commandSupported: boolean;
  disabled?: boolean;
  feedback?: CaptureActionFeedback;
  onSystemProxyChange(value: boolean): void;
  onTunHelperSetup?(operation: "install" | "repair"): Promise<TunHelperOperationResult>;
  onTunChange(value: boolean): void;
  systemProxyEnabled: boolean;
  systemProxySelected: boolean;
  systemProxyStatus: SystemProxyRuntimeStatusDto;
  tunEnabled: boolean;
  tunSelected: boolean;
  tunStatus: TunRuntimeStatusDto;
}

type TunSetupOperation = "install" | "repair";

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
  feedback = { busy: false, failure: null, operationId: null, phase: "idle" },
  onSystemProxyChange,
  onTunHelperSetup,
  onTunChange,
  systemProxyEnabled,
  systemProxySelected,
  systemProxyStatus,
  tunEnabled,
  tunSelected,
  tunStatus,
}: TrafficCaptureControlProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [tunGuideOpen, setTunGuideOpen] = useState(false);
  const [tunGuideOperation, setTunGuideOperation] = useState<TunSetupOperation | null>(null);
  const [tunSetupPending, setTunSetupPending] = useState(false);
  const tunGuideReturnFocus = useRef<HTMLElement | null>(null);
  const operationStatusId = useId();
  const { LL } = useI18nContext();
  const navigate = useNavigate();
  const systemProxyAvailable = isCaptureCapabilityAvailable(adapterKind, capabilities.systemProxy);
  const tunAvailable =
    adapterKind === "rpc" && isCaptureCapabilityAvailable(adapterKind, capabilities.tun);
  const canRequestAuthoritativeCaptureCheck = adapterKind === "rpc";
  const tunSetupOperation =
    adapterKind !== "rpc"
      ? null
      : capabilities.tun === "permission-required"
        ? "install"
        : capabilities.tun === "repair-required"
          ? "repair"
          : null;
  const tunSetupRequired = tunSetupOperation !== null;
  const guideTunSetupOperation = tunGuideOperation ?? tunSetupOperation;
  const guideTunSetupRequired = guideTunSetupOperation !== null;
  const tunActionable = canRequestAuthoritativeCaptureCheck || tunAvailable || tunSetupRequired;
  const tunDescriptionId = tunSetupRequired
    ? statusDescriptionIds.tunPermission
    : statusDescriptionIds.tunUnavailable;
  const systemProxyPending = feedback.busy && systemProxyStatus.phase === "pending";
  const tunPending = feedback.busy && tunStatus.phase === "pending";
  const captureDisabled = disabled || feedback.busy;

  function describedBy(...ids: Array<string | undefined>) {
    return ids.filter(Boolean).join(" ");
  }

  const operationAnnouncement = (() => {
    const copy = LL.capture.operationFeedback;
    switch (feedback.phase) {
      case "pending":
        return copy.pendingDescription();
      case "finalizing":
        return copy.finalizingDescription();
      case "error":
      case "success":
      case "idle":
        return "";
    }
  })();

  useEffect(() => {
    if (tunGuideOpen || !tunGuideReturnFocus.current) return;
    const trigger = tunGuideReturnFocus.current;
    tunGuideReturnFocus.current = null;
    trigger.focus();
  }, [tunGuideOpen]);

  function getHelpDescription(mode: "systemProxy" | "tun", availability: CapabilityAvailability) {
    if (adapterKind === "fixture") {
      return mode === "systemProxy"
        ? LL.capture.systemProxyFixtureDescription()
        : LL.capture.tunFixtureDescription();
    }
    if (availability === "permission-required" || availability === "repair-required") {
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

  function requestTunChange(selected: boolean) {
    if (selected && tunSetupOperation) {
      setTunGuideOperation(tunSetupOperation);
      tunGuideReturnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setTunGuideOpen(true);
      return;
    }
    onTunChange(selected);
  }

  function closeTunGuide(restoreFocus = true) {
    if (!restoreFocus) tunGuideReturnFocus.current = null;
    setTunGuideOperation(null);
    setTunGuideOpen(false);
  }

  async function setupTunHelperFromGuide() {
    if (!tunGuideOperation || !onTunHelperSetup || tunSetupPending) return;
    setTunSetupPending(true);
    try {
      const result = await onTunHelperSetup(tunGuideOperation);
      if (!result.ok) return;

      // The native lifecycle command resumes Capture from a fresh authority snapshot.
      closeTunGuide(false);
    } finally {
      setTunSetupPending(false);
    }
  }

  return (
    <>
      <div className={captureStyles().stack()}>
        <div aria-busy={feedback.busy} className={captureStyles().control()}>
          <Toggle
            aria-busy={systemProxyPending}
            aria-describedby={describedBy(
              getCaptureModeDescriptionId(
                adapterKind,
                capabilities.systemProxy,
                commandSupported,
                "systemProxy",
              ),
              operationStatusId,
            )}
            aria-label={LL.capture.modeAria({
              mode: LL.capture.systemProxy(),
              runtime: systemProxyEnabled ? LL.capture.running() : LL.capture.notRunning(),
              selection: systemProxySelected ? LL.capture.selected() : LL.capture.notSelected(),
            })}
            data-capture-state={getCaptureState(systemProxySelected, systemProxyEnabled)}
            disabled={
              captureDisabled ||
              (!canRequestAuthoritativeCaptureCheck && (!commandSupported || !systemProxyAvailable))
            }
            onPressedChange={onSystemProxyChange}
            pressed={systemProxySelected}
            variant="capture"
          >
            {systemProxyPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Desktop aria-hidden="true" data-icon="inline-start" weight="fill" />
            )}
            <span>{LL.capture.systemProxy()}</span>
          </Toggle>
          {tunActionable ? (
            <Toggle
              aria-busy={tunPending}
              aria-describedby={describedBy(
                getCaptureModeDescriptionId(adapterKind, capabilities.tun, commandSupported, "tun"),
                operationStatusId,
              )}
              aria-label={LL.capture.modeAria({
                mode: LL.capture.tun(),
                runtime: tunEnabled ? LL.capture.running() : LL.capture.notRunning(),
                selection: tunSelected ? LL.capture.selected() : LL.capture.notSelected(),
              })}
              data-capture-state={getCaptureState(tunSelected, tunEnabled)}
              disabled={captureDisabled}
              onPressedChange={requestTunChange}
              pressed={tunSelected}
              variant="capture"
            >
              {tunPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ShieldCheck aria-hidden="true" data-icon="inline-start" weight="fill" />
              )}
              <span>{LL.capture.tun()}</span>
            </Toggle>
          ) : (
            <Tooltip>
              <TooltipTrigger
                aria-describedby={describedBy(tunDescriptionId, operationStatusId)}
                aria-label={LL.capture.tun()}
                className="inline-flex rounded-md"
                data-capture-unavailable-trigger="true"
                render={<span tabIndex={0} />}
              >
                <Toggle
                  aria-busy={tunPending}
                  aria-describedby={tunDescriptionId}
                  aria-label={LL.capture.modeAria({
                    mode: LL.capture.tun(),
                    runtime: tunEnabled ? LL.capture.running() : LL.capture.notRunning(),
                    selection: tunSelected ? LL.capture.selected() : LL.capture.notSelected(),
                  })}
                  data-capture-state={getCaptureState(tunSelected, tunEnabled)}
                  disabled
                  pressed={tunSelected}
                  variant="capture"
                >
                  {tunPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ShieldCheck aria-hidden="true" data-icon="inline-start" weight="fill" />
                  )}
                  <span>{LL.capture.tun()}</span>
                </Toggle>
              </TooltipTrigger>
              <TooltipContent>
                {tunSetupRequired
                  ? getHelpDescription("tun", capabilities.tun)
                  : LL.capabilities.tunUnavailable()}
              </TooltipContent>
            </Tooltip>
          )}
          <Button
            aria-label={LL.capture.helpAria()}
            className="[&_svg]:text-muted-soft"
            onClick={() => setHelpOpen(true)}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <Question aria-hidden="true" />
          </Button>
        </div>
        <span
          aria-atomic="true"
          aria-live="polite"
          className="sr-only"
          data-capture-operation-phase={feedback.phase}
          id={operationStatusId}
          role="status"
        >
          {operationAnnouncement}
        </span>
        {adapterKind === "fixture" ? null : (
          <span aria-live="polite" className="sr-only" role="status">
            {systemProxyStatusMessage(LL, systemProxyStatus, systemProxyPending)}{" "}
            {tunStatusMessage(LL, tunStatus, tunPending)}
          </span>
        )}
      </div>

      <Dialog onOpenChange={setHelpOpen} open={helpOpen}>
        <DialogContent closeLabel={LL.common.close()}>
          <DialogHeader className={captureStyles().dialogHeader()}>
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
          </DialogHeader>
          <div className={captureStyles().explanations()}>
            <section className={captureStyles().explanation()}>
              <Desktop aria-hidden="true" />
              <div>
                <h2>{LL.capture.systemProxy()}</h2>
                <p>{getHelpDescription("systemProxy", capabilities.systemProxy)}</p>
              </div>
            </section>
            <section className={captureStyles().explanation()}>
              <ShieldCheck aria-hidden="true" />
              <div>
                <h2>{LL.capture.tun()}</h2>
                <p>{getHelpDescription("tun", capabilities.tun)}</p>
              </div>
            </section>
          </div>
          <DialogFooter className={captureStyles().dialogFooter()}>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {LL.capture.acknowledge()}
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (open) {
            setTunGuideOpen(true);
          } else if (!tunSetupPending) {
            closeTunGuide();
          }
        }}
        open={tunGuideOpen}
      >
        <DialogContent closeLabel={LL.common.close()} showCloseButton={!tunSetupPending}>
          <DialogHeader className={captureStyles().dialogHeader()}>
            <div className={captureStyles().guideHeaderCopy()} data-tun-setup-dialog-copy>
              <DialogTitle className="dialog-title" data-tun-setup-dialog-title>
                {LL.capture.tunGuide.title()}
              </DialogTitle>
              <DialogDescription className="dialog-description" data-tun-setup-dialog-description>
                {LL.capture.tunGuide.description()}
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className={captureStyles().explanations()}>
            <section className={captureStyles().guideExplanation()} data-tun-setup-explanation>
              <ShieldCheck aria-hidden="true" className={captureStyles().guideIcon()} />
              <div className={captureStyles().guideCopy()} data-tun-setup-copy>
                <h2 className={captureStyles().guideTitle()} data-tun-setup-title>
                  {guideTunSetupOperation === "repair"
                    ? LL.capture.tunGuide.repairTitle()
                    : LL.capture.tunGuide.setupTitle()}
                </h2>
                <p className={captureStyles().guideDescription()} data-tun-setup-description>
                  {guideTunSetupOperation === "repair"
                    ? LL.capture.tunGuide.repairDescription()
                    : LL.capture.tunGuide.setupDescription()}
                </p>
              </div>
            </section>
          </div>
          <DialogFooter className={captureStyles().guideDialogFooter()} data-tun-setup-actions>
            <DialogClose
              render={<Button disabled={tunSetupPending} type="button" variant="outline" />}
            >
              {LL.capture.tunGuide.notNow()}
            </DialogClose>
            {guideTunSetupRequired ? (
              onTunHelperSetup ? (
                <Button
                  aria-busy={tunSetupPending}
                  disabled={tunSetupPending}
                  onClick={() => void setupTunHelperFromGuide()}
                  type="button"
                >
                  {guideTunSetupOperation === "repair"
                    ? tunSetupPending
                      ? LL.capture.tunGuide.repairingHelper()
                      : LL.capture.tunGuide.repairHelper()
                    : tunSetupPending
                      ? LL.capture.tunGuide.installingHelper()
                      : LL.capture.tunGuide.installHelper()}
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    closeTunGuide(false);
                    void navigate("/settings");
                  }}
                  type="button"
                >
                  {LL.capture.tunGuide.reviewSetup()}
                </Button>
              )
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
