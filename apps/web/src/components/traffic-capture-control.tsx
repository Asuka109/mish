import { ArrowsClockwise } from "@phosphor-icons/react/ArrowsClockwise";
import { Desktop } from "@phosphor-icons/react/Desktop";
import { Question } from "@phosphor-icons/react/Question";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { useState } from "react";
import { useNavigate } from "react-router";
import { tv } from "tailwind-variants";
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
} from "../data/status-capabilities";
import { systemProxyStatusMessage, tunStatusMessage } from "../data/capture-status-message";
import { tunHelperFailureMessage } from "../data/tun-helper-failure-message";

const legacyTunGuideStorageKey = "mish.tun-helper-guide.v1";
const tunGuideStorageKey = "mish.tun-helper-guide.v2";

const captureStyles = tv({
  slots: {
    stack: "traffic-capture-stack flex min-w-0 flex-col items-start gap-1.5 py-2.5",
    control: "inline-flex flex-wrap items-center gap-2",
    dialogHeader: "border-0",
    explanations: "px-4 py-1.5",
    explanation:
      "grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 py-[14px] [&>svg]:mt-px [&>svg]:size-[18px] [&>svg]:text-(--color-text-muted) [&_p]:mt-1 [&_p]:text-(--text-metadata) [&_p]:leading-5 [&_p]:text-(--color-text-muted)",
    dialogFooter: "border-0",
  },
});

function completedTunGuideIdentity() {
  try {
    const identity = globalThis.localStorage?.getItem(tunGuideStorageKey) ?? null;
    globalThis.localStorage?.removeItem(legacyTunGuideStorageKey);
    return identity;
  } catch {
    return null;
  }
}

function persistCompletedTunGuide(identity: string) {
  try {
    globalThis.localStorage?.setItem(tunGuideStorageKey, identity);
    globalThis.localStorage?.removeItem(legacyTunGuideStorageKey);
  } catch {
    // A blocked storage surface keeps the guide session-local.
  }
}

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
  tunGuideIdentity: string | null;
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
  tunGuideIdentity,
  tunHelperReady = false,
  tunSelected,
  tunStatus,
}: TrafficCaptureControlProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [completedIdentity, setCompletedIdentity] = useState(completedTunGuideIdentity);
  const [tunGuideOpen, setTunGuideOpen] = useState(false);
  const [tunInstallFailure, setTunInstallFailure] = useState<
    Extract<TunHelperOperationResult, { ok: false }>["failure"] | undefined
  >();
  const [tunInstallPending, setTunInstallPending] = useState(false);
  const { LL } = useI18nContext();
  const navigate = useNavigate();
  const systemProxyAvailable = isCaptureCapabilityAvailable(adapterKind, capabilities.systemProxy);
  const tunAvailable =
    isCaptureCapabilityAvailable(adapterKind, capabilities.tun) ||
    (adapterKind === "rpc" && tunHelperReady);
  const tunSetupRequired =
    adapterKind === "rpc" && capabilities.tun === "permission-required" && !tunHelperReady;
  const tunGuideCompleted = tunGuideIdentity !== null && completedIdentity === tunGuideIdentity;

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
    if (selected && adapterKind === "rpc" && (tunSetupRequired || !tunGuideCompleted)) {
      setTunGuideOpen(true);
      return;
    }
    onTunChange(selected);
  }

  function enableTunAfterGuide() {
    if (tunGuideIdentity !== null) persistCompletedTunGuide(tunGuideIdentity);
    setCompletedIdentity(tunGuideIdentity);
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
            disabled={disabled || !commandSupported || !systemProxyAvailable}
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
            disabled={disabled || !commandSupported || (!tunAvailable && !tunSetupRequired)}
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
          <Button
            aria-label={LL.capture.helpAria()}
            className="[&_svg]:text-(--color-muted-soft)"
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
            <section className={captureStyles().explanation()}>
              <ArrowsClockwise aria-hidden="true" />
              <div>
                <h2>{LL.capture.tunGuide.restartTitle()}</h2>
                <p>{LL.capture.tunGuide.restartDescription()}</p>
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
