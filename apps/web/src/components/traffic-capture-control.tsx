import { Desktop } from "@phosphor-icons/react/Desktop";
import { Question } from "@phosphor-icons/react/Question";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { useState } from "react";
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
import {
  getCaptureModeDescriptionId,
  isCaptureCapabilityAvailable,
  statusDescriptionIds,
} from "../data/status-capabilities";
import { systemProxyStatusMessage, tunStatusMessage } from "../data/capture-status-message";
import { tunHelperFailureMessage } from "../data/tun-helper-failure-message";

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
    dialogFooter: "border-0",
  },
});

interface TrafficCaptureControlProps {
  adapterKind: StatusAdapterKind;
  capabilities: PlatformCapabilitiesDto;
  commandSupported: boolean;
  disabled?: boolean;
  onSystemProxyChange(value: boolean): void;
  onTunHelperInstall?(): Promise<TunHelperOperationResult>;
  onTunChange(value: boolean): void;
  pending?: boolean;
  pendingMode?: "systemProxy" | "tun" | null;
  systemProxyEnabled: boolean;
  systemProxySelected: boolean;
  systemProxyStatus: SystemProxyRuntimeStatusDto;
  tunEnabled: boolean;
  tunHelperReady?: boolean;
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
  onTunHelperInstall,
  onTunChange,
  pending = false,
  pendingMode = null,
  systemProxyEnabled,
  systemProxySelected,
  systemProxyStatus,
  tunEnabled,
  tunHelperReady = false,
  tunSelected,
  tunStatus,
}: TrafficCaptureControlProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [tunGuideOpen, setTunGuideOpen] = useState(false);
  const [tunInstallFailure, setTunInstallFailure] = useState<
    Extract<TunHelperOperationResult, { ok: false }>["failure"] | undefined
  >();
  const [tunInstallPending, setTunInstallPending] = useState(false);
  const { LL } = useI18nContext();
  const navigate = useNavigate();
  const systemProxyAvailable = isCaptureCapabilityAvailable(adapterKind, capabilities.systemProxy);
  const tunAvailable =
    adapterKind === "rpc" && isCaptureCapabilityAvailable(adapterKind, capabilities.tun);
  const canRequestAuthoritativeCaptureCheck = adapterKind === "rpc";
  const tunRequiresPermission = capabilities.tun === "permission-required";
  const tunSetupRequired = adapterKind === "rpc" && tunRequiresPermission && !tunHelperReady;
  const tunDescriptionId = tunRequiresPermission
    ? statusDescriptionIds.tunPermission
    : statusDescriptionIds.tunUnavailable;

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

  function requestTunChange(selected: boolean) {
    if (selected && tunSetupRequired) {
      setTunGuideOpen(true);
      return;
    }
    onTunChange(selected);
  }

  function enableTunAfterGuide() {
    setTunGuideOpen(false);
    onTunChange(true);
  }

  async function installTunHelperFromGuide() {
    if (!onTunHelperInstall || tunInstallPending) return;
    setTunInstallFailure(undefined);
    setTunInstallPending(true);
    const result = await onTunHelperInstall();
    setTunInstallPending(false);
    setTunInstallFailure(result.ok ? undefined : result.failure);
  }

  return (
    <>
      <div className={captureStyles().stack()}>
        <div className={captureStyles().control()}>
          <Toggle
            aria-busy={pendingMode === "systemProxy"}
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
            data-capture-state={getCaptureState(systemProxySelected, systemProxyEnabled)}
            disabled={
              disabled ||
              (!canRequestAuthoritativeCaptureCheck && (!commandSupported || !systemProxyAvailable))
            }
            onPressedChange={onSystemProxyChange}
            pressed={systemProxySelected}
            variant="capture"
          >
            {pendingMode === "systemProxy" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Desktop aria-hidden="true" data-icon="inline-start" weight="fill" />
            )}
            <span>{LL.capture.systemProxy()}</span>
          </Toggle>
          {tunAvailable || canRequestAuthoritativeCaptureCheck ? (
            <Toggle
              aria-busy={pendingMode === "tun"}
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
              data-capture-state={getCaptureState(tunSelected, tunEnabled)}
              disabled={disabled}
              onPressedChange={requestTunChange}
              pressed={tunSelected}
              variant="capture"
            >
              {pendingMode === "tun" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <ShieldCheck aria-hidden="true" data-icon="inline-start" weight="fill" />
              )}
              <span>{LL.capture.tun()}</span>
            </Toggle>
          ) : (
            <Tooltip>
              <TooltipTrigger
                aria-describedby={tunDescriptionId}
                aria-label={LL.capture.tun()}
                aria-disabled="true"
                className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-focus-accent focus-visible:outline-offset-2"
                data-capture-unavailable-trigger="true"
                render={<span tabIndex={0} />}
              >
                <Toggle
                  aria-busy={pendingMode === "tun"}
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
                  {pendingMode === "tun" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ShieldCheck aria-hidden="true" data-icon="inline-start" weight="fill" />
                  )}
                  <span>{LL.capture.tun()}</span>
                </Toggle>
              </TooltipTrigger>
              <TooltipContent>
                {tunRequiresPermission
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
        {adapterKind === "fixture" ? null : (
          <span aria-live="polite" className="sr-only" role="status">
            {systemProxyStatusMessage(LL, systemProxyStatus, pending)}{" "}
            {tunStatusMessage(LL, tunStatus, pending)}
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

      <Dialog onOpenChange={setTunGuideOpen} open={tunGuideOpen}>
        <DialogContent closeLabel={LL.common.close()}>
          <DialogHeader className={captureStyles().dialogHeader()}>
            <DialogTitle className="dialog-title">{LL.capture.tunGuide.title()}</DialogTitle>
            <DialogDescription className="dialog-description">
              {LL.capture.tunGuide.description()}
            </DialogDescription>
          </DialogHeader>
          <div className={captureStyles().explanations()}>
            <section className={captureStyles().explanation()}>
              <ShieldCheck aria-hidden="true" />
              <div>
                <h2>
                  {tunSetupRequired
                    ? LL.capture.tunGuide.setupTitle()
                    : LL.capture.tunGuide.helperTitle()}
                </h2>
                <p>
                  {tunSetupRequired
                    ? LL.capture.tunGuide.setupDescription()
                    : LL.capture.tunGuide.helperDescription()}
                </p>
              </div>
            </section>
          </div>
          <DialogFooter className={captureStyles().dialogFooter()}>
            {tunInstallFailure !== undefined ? (
              <p className="dialog-error" role="alert">
                {tunHelperFailureMessage(LL, tunInstallFailure)}
              </p>
            ) : null}
            <DialogClose render={<Button type="button" variant="outline" />}>
              {LL.capture.tunGuide.notNow()}
            </DialogClose>
            {tunSetupRequired ? (
              onTunHelperInstall ? (
                <Button
                  aria-busy={tunInstallPending}
                  disabled={tunInstallPending}
                  onClick={() => void installTunHelperFromGuide()}
                  type="button"
                >
                  {tunInstallPending
                    ? LL.capture.tunGuide.installingHelper()
                    : LL.capture.tunGuide.installHelper()}
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setTunGuideOpen(false);
                    void navigate("/settings");
                  }}
                  type="button"
                >
                  {LL.capture.tunGuide.reviewSetup()}
                </Button>
              )
            ) : (
              <Button onClick={enableTunAfterGuide} type="button">
                {LL.capture.tunGuide.enable()}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
