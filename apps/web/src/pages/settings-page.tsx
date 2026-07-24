import { Warning } from "@phosphor-icons/react/Warning";
import {
  Badge,
  Button,
  SettingsGroup,
  SettingsRow as SettingsRowPrimitive,
  SettingsRowControl,
  SettingsRowCopy,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import type {
  AppearancePreference,
  CaptureSelectionDto,
  LanguagePreference,
  ManagedPortPreferencesDto,
  SettingsAvailability,
  StartupPreferencesDto,
  SystemProxyTakeoverPolicy,
  WindowCloseBehavior,
  WindowSurfacePreference,
} from "@mish/contracts";
import { LOCAL_PROXY_HOST, LOCAL_PROXY_PORT } from "@mish/contracts";
import { TrafficCaptureControl } from "../components/traffic-capture-control";
import { LocalBackupControl } from "../components/local-backup-control";
import { useAppearance } from "../appearance";
import { useCaptureCommand } from "../data/capture-command";
import { useProduct } from "../data/product-provider";
import { useSettings } from "../data/settings-provider";
import { tunHelperFailureMessage } from "../data/tun-helper-failure-message";
import { useI18nContext } from "../i18n/i18n-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { cx, tv } from "@mish/ui/tv";

type PendingButtonAction =
  | "language"
  | "managed-ports"
  | "proxy-launch"
  | "takeover-policy"
  | "startup"
  | "window-close";

type StartupOption = "off" | "show-window" | "background";

type PromiseButtonAction =
  | "install-helper"
  | "refresh-network"
  | "reinstall-helper"
  | "remove-helper"
  | "repair-helper";

const settingsStyles = tv({
  slots: {
    page: cx(
      "@container/settings-page mx-auto w-full max-w-page-narrow px-8 pt-8 pb-12",
      "max-page-compact:p-6 max-shell-mobile:px-4 max-shell-mobile:pt-4.5 max-shell-mobile:pb-6",
      "[&>header+section]:mt-6",
    ),
    header: cx(
      "[&_h1]:text-title [&_h1]:font-semibold [&_h1]:tracking-title-tight [&_p]:mt-1.75",
      "[&_p]:max-w-175 [&_p]:leading-5.25 [&_p]:text-muted-foreground",
    ),
    notice: cx(
      "mt-6 flex items-start gap-2 rounded-md border border-feedback-warning-border px-3 py-2.5",
      "text-metadata text-warning [&>svg]:mt-px [&>svg]:size-4 [&>svg]:shrink-0",
    ),
    section: "mt-7",
    heading: cx(
      "px-1 pb-2.5 [&_h2]:text-body [&_h2]:font-semibold [&_p]:mt-0.75 [&_p]:max-w-180",
      "[&_p]:text-metadata [&_p]:leading-4.75 [&_p]:text-muted-foreground",
    ),
    control:
      "[&_.traffic-capture-stack]:items-end @max-settings-compact/settings-page:[&_.traffic-capture-stack]:items-start",
    inline: cx(
      "inline-flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2",
      "@max-settings-compact/settings-page:justify-start [&_label]:inline-grid [&_label]:gap-0.75",
      "[&_label]:text-start [&_label]:text-label-small [&_label]:leading-3.5",
      "[&_label]:text-muted-foreground [&_input[type=number]]:min-h-7.5",
      "[&_input[type=number]]:w-20.5 [&_input[type=number]]:rounded-sm",
      "[&_input[type=number]]:border [&_input[type=number]]:border-hairline",
      "[&_input[type=number]]:bg-canvas [&_input[type=number]]:px-1.75 [&_input[type=number]]:py-1",
      "[&_input[type=number]]:text-fg",
    ),
    controlStack: cx(
      "flex min-w-0 max-w-full flex-col items-end gap-2",
      "@max-settings-compact/settings-page:items-start",
    ),
    policyWarning: cx(
      "max-w-80 text-end text-metadata leading-4.5 text-warning",
      "@max-settings-compact/settings-page:max-w-full @max-settings-compact/settings-page:text-start",
    ),
    localProxy: cx(
      "flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2",
      "@max-settings-compact/settings-page:justify-start [&_.ui-button]:min-w-28",
      "[&_.ui-button[aria-busy=true]:disabled]:opacity-100",
    ),
    localProxyEndpoint: "flex flex-wrap items-center gap-2 [&_code]:text-ink [&_code]:tabular-nums",
    networkList: cx(
      "grid max-w-90 justify-items-end gap-2 text-end text-metadata text-fg",
      "data-[phase=stale]:opacity-68 data-[phase=failed]:opacity-68",
      "@max-settings-compact/settings-page:max-w-full",
      "@max-settings-compact/settings-page:justify-items-start",
      "@max-settings-compact/settings-page:text-start",
    ),
    networkPrimary: cx(
      "grid max-w-90 justify-items-end gap-0.75 text-end text-metadata text-fg",
      "@max-settings-compact/settings-page:max-w-full",
      "@max-settings-compact/settings-page:justify-items-start",
      "@max-settings-compact/settings-page:text-start [&>strong]:font-medium [&>span]:text-metadata",
      "[&>span]:text-muted-foreground",
    ),
    networkEmpty: "text-metadata text-muted-foreground",
    networkAddresses: cx(
      "grid max-w-90 justify-items-end gap-2 text-end text-metadata text-fg",
      "data-[phase=stale]:opacity-68 data-[phase=failed]:opacity-68",
      "@max-settings-compact/settings-page:max-w-full",
      "@max-settings-compact/settings-page:justify-items-start",
      "@max-settings-compact/settings-page:text-start [&>span]:justify-end",
      "@max-settings-compact/settings-page:[&>span]:justify-start [&_code]:font-mono",
      "[&_code]:text-caption [&_code]:text-muted-foreground",
    ),
    networkDetail: cx(
      "grid max-w-90 justify-items-end gap-0.75 text-end text-metadata text-fg",
      "data-[phase=stale]:opacity-68 data-[phase=failed]:opacity-68",
      "@max-settings-compact/settings-page:max-w-full",
      "@max-settings-compact/settings-page:justify-items-start",
      "@max-settings-compact/settings-page:text-start [&>span:first-child]:text-metadata",
      "[&>span:first-child]:text-muted-foreground",
    ),
    observedValues: cx(
      "flex max-w-105 flex-wrap justify-end gap-1 @max-settings-compact/settings-page:max-w-full",
      "@max-settings-compact/settings-page:justify-start [&_code]:max-w-full [&_code]:truncate",
      "[&_code]:rounded-sm [&_code]:border [&_code]:border-hairline [&_code]:bg-surface-soft",
      "[&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-caption [&_code]:text-fg",
    ),
  },
});

function AvailabilityBadge({ availability }: { availability: SettingsAvailability }) {
  const { LL } = useI18nContext();
  const label =
    availability === "supported"
      ? LL.settingsPage.available()
      : availability === "coming-later"
        ? LL.settingsPage.comingSoon()
        : LL.common.unavailable();
  return <Badge variant={availability === "supported" ? "success" : "outline"}>{label}</Badge>;
}

function SettingsSection({
  children,
  description,
  id,
  title,
}: {
  children: ReactNode;
  description: string;
  id: string;
  title: string;
}) {
  return (
    <section aria-labelledby={id} className={settingsStyles().section()}>
      <div className={settingsStyles().heading()}>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

function SettingsRow({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <SettingsRowPrimitive>
      <SettingsRowCopy>
        <strong>{title}</strong>
        <span>{description}</span>
      </SettingsRowCopy>
      <SettingsRowControl className={settingsStyles().control()}>{children}</SettingsRowControl>
    </SettingsRowPrimitive>
  );
}

function ObservedValues({ empty, values }: { empty: string; values: string[] }) {
  if (values.length === 0) return <span className={settingsStyles().networkEmpty()}>{empty}</span>;
  return (
    <span className={settingsStyles().observedValues()}>
      {values.map((value) => (
        <code key={value}>{value}</code>
      ))}
    </span>
  );
}

function AddressAvailabilityBadge({
  available,
  family,
}: {
  available: boolean;
  family: "IPv4" | "IPv6";
}) {
  const { LL } = useI18nContext();
  const status = available ? LL.settingsPage.available() : LL.common.unavailable();
  return (
    <Badge
      aria-label={`${family}: ${status}`}
      title={`${family}: ${status}`}
      variant={available ? "success" : "outline"}
    >
      {family}
      <span className="sr-only">: {status}</span>
    </Badge>
  );
}

export function SettingsPage() {
  const location = useLocation();
  const {
    appearancePending,
    preference,
    setPreference,
    setWindowSurfacePreference,
    windowSurfaceFallbackReason,
    windowSurfacePending,
    windowSurfacePreference,
  } = useAppearance();
  const {
    connection: productConnection,
    isCommandSupported,
    localProxyTest,
    snapshot: product,
    testLocalProxy,
  } = useProduct();
  const { pending: capturePending, setCapture } = useCaptureCommand();
  const settings = useSettings();
  const [pendingButtonAction, setPendingButtonAction] = useState<PendingButtonAction | null>(null);
  const [buttonActionPromise, setButtonActionPromise] = useState<{
    action: PromiseButtonAction;
    promise: Promise<unknown>;
  } | null>(null);
  const [optimisticCaptureSelection, setOptimisticCaptureSelection] =
    useState<CaptureSelectionDto | null>(null);
  const [pendingCaptureMode, setPendingCaptureMode] = useState<"systemProxy" | "tun" | null>(null);
  const [optimisticStartup, setOptimisticStartup] = useState<StartupPreferencesDto | null>(null);
  const [optimisticLaunchProxy, setOptimisticLaunchProxy] = useState<boolean | null>(null);
  const [optimisticTakeoverPolicy, setOptimisticTakeoverPolicy] =
    useState<SystemProxyTakeoverPolicy | null>(null);
  const [optimisticWindowClose, setOptimisticWindowClose] = useState<WindowCloseBehavior | null>(
    null,
  );
  const [pendingLanguage, setPendingLanguage] = useState<LanguagePreference | null>(null);
  const [managedPorts, setManagedPorts] = useState<ManagedPortPreferencesDto | null>(null);
  const networkAutoRefreshStarted = useRef(false);
  const { LL, locale } = useI18nContext();
  const snapshot = settings.snapshot;
  const startup = snapshot.preferences.startup;
  const displayedManagedPorts = managedPorts ?? snapshot.preferences.managedPorts;
  const displayedStartup = optimisticStartup ?? startup;
  const displayedStartupOption: StartupOption = displayedStartup.launchAtLogin
    ? displayedStartup.loginLaunchBehavior
    : "off";
  const captureSupported = isCommandSupported("capture");
  const captureRuntime = product?.runtime;
  const captureActive = Boolean(captureRuntime?.systemProxyEnabled || captureRuntime?.tunEnabled);
  const startupSupported =
    snapshot.adapterKind === "rpc" && snapshot.capabilities.launchAtLogin === "supported";
  const launchProxySupported =
    snapshot.adapterKind === "rpc" && snapshot.capabilities.backgroundLaunch === "supported";
  const displayedLaunchProxy = optimisticLaunchProxy ?? startup.launchProxyWhenMishLaunches;
  const displayedTakeoverPolicy =
    optimisticTakeoverPolicy ?? snapshot.preferences.systemProxyTakeoverPolicy;
  const helper = snapshot.tunHelper;
  const helperAvailable =
    helper.availability === "available" &&
    helper.health === "healthy" &&
    helper.installedVersion === helper.expectedVersion &&
    helper.phase === "idle" &&
    helper.lastFailure === null;
  const network = snapshot.networkDns;
  const networkSupported =
    snapshot.adapterKind === "rpc" && snapshot.capabilities.networkDns === "supported";

  useEffect(() => {
    if (new URLSearchParams(location.search).get("focus") !== "system-proxy-takeover-policy") {
      return;
    }
    const control = document.getElementById("system-proxy-takeover-policy");
    control?.scrollIntoView({ block: "center" });
    const focusable = control?.querySelector<HTMLElement>("button[aria-pressed='true'], button");
    focusable?.focus();
  }, [location.search]);

  useEffect(() => {
    if (!networkSupported || network.phase !== "unknown" || networkAutoRefreshStarted.current) {
      return;
    }
    networkAutoRefreshStarted.current = true;
    void settings.refreshNetworkDns();
  }, [network.phase, networkSupported, settings]);

  async function changeCaptureMode(mode: "systemProxy" | "tun", selected: boolean) {
    if (!captureRuntime || !captureSupported) return;
    const selection = { ...captureRuntime.captureSelection, [mode]: selected };
    const active = captureActive ? selection.systemProxy || selection.tun : selected;
    setOptimisticCaptureSelection(selection);
    setPendingCaptureMode(mode);
    try {
      await setCapture(selection, active);
    } finally {
      setOptimisticCaptureSelection(null);
      setPendingCaptureMode(null);
    }
  }

  function runPromiseButtonAction(action: PromiseButtonAction, operation: () => Promise<unknown>) {
    setButtonActionPromise({ action, promise: operation() });
  }

  function loadingPromise(action: PromiseButtonAction) {
    return buttonActionPromise?.action === action ? buttonActionPromise.promise : false;
  }

  async function changeLanguage(values: string[]) {
    const language = values[0];
    if (language !== "en" && language !== "zh-CN") return;
    setPendingButtonAction("language");
    setPendingLanguage(language);
    try {
      await settings.setLanguage(language);
    } finally {
      setPendingButtonAction(null);
      setPendingLanguage(null);
    }
  }

  async function changeStartup(option: StartupOption) {
    const nextStartup: StartupPreferencesDto =
      option === "off"
        ? { ...startup, launchAtLogin: false }
        : { ...startup, launchAtLogin: true, loginLaunchBehavior: option };
    setPendingButtonAction("startup");
    setOptimisticStartup(nextStartup);
    try {
      await settings.setStartup(nextStartup);
    } finally {
      setPendingButtonAction(null);
      setOptimisticStartup(null);
    }
  }

  async function changeLaunchProxyWhenMishLaunches(launchProxyWhenMishLaunches: boolean) {
    setPendingButtonAction("proxy-launch");
    setOptimisticLaunchProxy(launchProxyWhenMishLaunches);
    try {
      await settings.setLaunchProxyWhenMishLaunches(launchProxyWhenMishLaunches);
    } finally {
      setPendingButtonAction(null);
      setOptimisticLaunchProxy(null);
    }
  }

  async function changeTakeoverPolicy(policy: SystemProxyTakeoverPolicy) {
    setPendingButtonAction("takeover-policy");
    setOptimisticTakeoverPolicy(policy);
    try {
      await settings.setSystemProxyTakeoverPolicy(policy);
    } finally {
      setPendingButtonAction(null);
      setOptimisticTakeoverPolicy(null);
    }
  }

  async function changeWindowCloseBehavior(behavior: WindowCloseBehavior) {
    setPendingButtonAction("window-close");
    setOptimisticWindowClose(behavior);
    try {
      await settings.setWindowCloseBehavior(behavior);
    } finally {
      setPendingButtonAction(null);
      setOptimisticWindowClose(null);
    }
  }

  async function saveManagedPorts() {
    setPendingButtonAction("managed-ports");
    try {
      await settings.setManagedPorts(displayedManagedPorts);
    } finally {
      setPendingButtonAction(null);
      setManagedPorts(null);
    }
  }

  async function findManagedPorts() {
    setPendingButtonAction("managed-ports");
    try {
      if (await settings.findManagedPorts()) setManagedPorts(null);
    } finally {
      setPendingButtonAction(null);
    }
  }

  function changeAppearance(values: string[]) {
    const appearance = values[0] as AppearancePreference | undefined;
    if (!appearance || !["system", "light", "dark"].includes(appearance)) return;
    setPreference(appearance);
  }

  function changeWindowSurface(values: string[]) {
    const surface = values[0] as WindowSurfacePreference | undefined;
    if (surface !== "opaque" && surface !== "material") return;
    setWindowSurfacePreference(surface);
  }

  function networkObservationDescription() {
    if (network.phase === "ready" && network.observedAt !== null) {
      const time = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(network.observedAt));
      return LL.settingsPage.networkDns.observationReady({ time });
    }
    if (network.phase === "failed") {
      const failure = network.failure;
      return failure
        ? `${LL.settingsPage.networkDns.observationFailed()} ${LL.settingsPage.networkDns.failure[failure]()}`
        : LL.settingsPage.networkDns.observationFailed();
    }
    if (network.phase === "stale") return LL.settingsPage.networkDns.observationStale();
    if (network.phase === "unavailable") {
      return LL.settingsPage.networkDns.observationUnavailable();
    }
    return LL.settingsPage.networkDns.observationUnknown();
  }

  return (
    <div className={settingsStyles().page()}>
      <header className={settingsStyles().header()}>
        <h1>{LL.settingsPage.title()}</h1>
        <p>
          {snapshot.adapterKind === "fixture"
            ? LL.settingsPage.fixtureDescription()
            : LL.settingsPage.description()}
        </p>
      </header>

      {snapshot.storageRecovered ? (
        <p className={settingsStyles().notice()} role="status">
          <Warning aria-hidden="true" />
          {LL.settingsPage.storageRecovered()}
        </p>
      ) : null}

      <SettingsSection
        description={LL.settingsPage.captureStartupDescription()}
        id="settings-capture-startup"
        title={LL.settingsPage.captureStartup()}
      >
        <SettingsRow
          description={LL.settingsPage.managedPortsDescription()}
          title={LL.settingsPage.managedPorts()}
        >
          <div className={settingsStyles().inline()}>
            <label>
              Proxy
              <input
                aria-label="Managed proxy port"
                inputMode="numeric"
                max={65535}
                min={1}
                onChange={(event) =>
                  setManagedPorts({
                    ...displayedManagedPorts,
                    proxy: Number(event.target.value),
                  })
                }
                type="number"
                value={displayedManagedPorts.proxy}
              />
            </label>
            <label>
              Controller
              <input
                aria-label="Managed Controller port"
                inputMode="numeric"
                max={65535}
                min={1}
                onChange={(event) =>
                  setManagedPorts({
                    ...displayedManagedPorts,
                    controller: Number(event.target.value),
                  })
                }
                type="number"
                value={displayedManagedPorts.controller}
              />
            </label>
            <Button
              disabled={
                settings.pending ||
                displayedManagedPorts.proxy < 1 ||
                displayedManagedPorts.proxy > 65535 ||
                displayedManagedPorts.controller < 1 ||
                displayedManagedPorts.controller > 65535 ||
                displayedManagedPorts.proxy === displayedManagedPorts.controller
              }
              loading={pendingButtonAction === "managed-ports"}
              loadingText={LL.settingsPage.managedPortsSave()}
              onClick={() => void saveManagedPorts()}
              size="sm"
              type="button"
              variant="outline"
            >
              {LL.settingsPage.managedPortsSave()}
            </Button>
            <Button
              disabled={settings.pending}
              loading={pendingButtonAction === "managed-ports"}
              loadingText={LL.settingsPage.managedPortsFind()}
              onClick={() => void findManagedPorts()}
              size="sm"
              type="button"
              variant="outline"
            >
              {LL.settingsPage.managedPortsFind()}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.trafficCaptureDescription()}
          title={LL.settingsPage.trafficCapture()}
        >
          {product && captureRuntime ? (
            <TrafficCaptureControl
              adapterKind={product.adapterKind}
              capabilities={{
                ...product.capabilities,
                tun:
                  snapshot.capabilities.tun === "supported"
                    ? product.capabilities.tun
                    : "unavailable",
              }}
              commandSupported={captureSupported}
              disabled={capturePending || captureRuntime.systemProxy.recoveryActions.length > 0}
              onSystemProxyChange={(selected) => changeCaptureMode("systemProxy", selected)}
              pending={capturePending}
              pendingMode={pendingCaptureMode}
              systemProxyEnabled={captureRuntime.systemProxyEnabled}
              systemProxySelected={
                optimisticCaptureSelection?.systemProxy ??
                captureRuntime.captureSelection.systemProxy
              }
              systemProxyStatus={captureRuntime.systemProxy}
              tunEnabled={captureRuntime.tunEnabled}
              tunSelected={optimisticCaptureSelection?.tun ?? captureRuntime.captureSelection.tun}
              tunStatus={captureRuntime.tun}
            />
          ) : (
            <AvailabilityBadge availability="unavailable" />
          )}
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.systemProxyTakeoverPolicyDescription()}
          title={LL.settingsPage.systemProxyTakeoverPolicy()}
        >
          <div className={settingsStyles().controlStack()}>
            <ToggleGroup
              aria-describedby="system-proxy-takeover-policy-warning"
              aria-label={LL.settingsPage.systemProxyTakeoverPolicy()}
              disabled={snapshot.adapterKind !== "rpc" || settings.pending}
              id="system-proxy-takeover-policy"
              onValueChange={(values) => {
                const policy = values[0];
                if (
                  policy === "protect-existing" ||
                  policy === "replace-reversible-pac-or-auto-discovery"
                ) {
                  void changeTakeoverPolicy(policy);
                }
              }}
              spacing={0}
              value={[displayedTakeoverPolicy]}
              variant="segmented"
            >
              <ToggleGroupItem
                aria-busy={
                  pendingButtonAction === "takeover-policy" &&
                  displayedTakeoverPolicy === "protect-existing"
                }
                value="protect-existing"
              >
                {LL.settingsPage.systemProxyTakeoverPolicyProtected()}
              </ToggleGroupItem>
              <ToggleGroupItem
                aria-busy={
                  pendingButtonAction === "takeover-policy" &&
                  displayedTakeoverPolicy === "replace-reversible-pac-or-auto-discovery"
                }
                value="replace-reversible-pac-or-auto-discovery"
              >
                {LL.settingsPage.systemProxyTakeoverPolicyAdvanced()}
              </ToggleGroupItem>
            </ToggleGroup>
            <span
              id="system-proxy-takeover-policy-warning"
              className={settingsStyles().policyWarning()}
            >
              {LL.settingsPage.systemProxyTakeoverPolicyWarning()}
            </span>
          </div>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.tunHelperDescription()}
          title={LL.settingsPage.tunHelper()}
        >
          <div className={settingsStyles().controlStack()}>
            <div className={settingsStyles().inline()}>
              <Badge
                variant={
                  helperAvailable
                    ? "success"
                    : helper.availability === "permission-required" ||
                        helper.availability === "repair-required"
                      ? "warning"
                      : "outline"
                }
              >
                {helperAvailable
                  ? LL.settingsPage.tunHelperHealthy({ version: helper.installedVersion ?? "-" })
                  : helper.availability === "repair-required"
                    ? LL.settingsPage.tunHelperRepairRequired()
                    : helper.availability === "permission-required"
                      ? LL.settingsPage.tunHelperNotInstalled()
                      : helper.availability === "unsigned-app"
                        ? LL.settingsPage.tunHelperUnsigned()
                        : helper.availability === "unpackaged"
                          ? LL.settingsPage.tunHelperUnpackaged()
                          : LL.common.unavailable()}
              </Badge>
              {helper.availability === "permission-required" ? (
                <Button
                  disabled={settings.pending}
                  loading={loadingPromise("install-helper")}
                  loadingText={LL.settingsPage.installTunHelper()}
                  onClick={() =>
                    runPromiseButtonAction("install-helper", settings.installTunHelper)
                  }
                  size="sm"
                  type="button"
                >
                  {LL.settingsPage.installTunHelper()}
                </Button>
              ) : null}
              {helper.availability === "repair-required" ? (
                <Button
                  disabled={settings.pending}
                  loading={loadingPromise("repair-helper")}
                  loadingText={LL.settingsPage.repairTunHelper()}
                  onClick={() => runPromiseButtonAction("repair-helper", settings.repairTunHelper)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {LL.settingsPage.repairTunHelper()}
                </Button>
              ) : null}
              {helperAvailable ? (
                <Button
                  disabled={settings.pending || product?.runtime.phase !== "inactive"}
                  loading={loadingPromise("reinstall-helper")}
                  loadingText={LL.settingsPage.reinstallTunHelper()}
                  onClick={() =>
                    runPromiseButtonAction("reinstall-helper", settings.repairTunHelper)
                  }
                  size="sm"
                  title={
                    product?.runtime.phase !== "inactive"
                      ? LL.settingsPage.reinstallTunHelperBlocked()
                      : undefined
                  }
                  type="button"
                  variant="outline"
                >
                  {LL.settingsPage.reinstallTunHelper()}
                </Button>
              ) : null}
              {helperAvailable ? (
                <Button
                  disabled={settings.pending || product?.runtime.phase !== "inactive"}
                  loading={loadingPromise("remove-helper")}
                  loadingText={LL.settingsPage.removeTunHelper()}
                  onClick={() => runPromiseButtonAction("remove-helper", settings.removeTunHelper)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {LL.settingsPage.removeTunHelper()}
                </Button>
              ) : null}
            </div>
            {settings.tunHelperFailure || helper.lastFailure ? (
              <p className="dialog-error" role="alert">
                {tunHelperFailureMessage(LL, settings.tunHelperFailure ?? helper.lastFailure)}
              </p>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.localProxy.description()}
          title={LL.settingsPage.localProxy.title()}
        >
          {product?.adapterKind === "rpc" ? (
            <div className={settingsStyles().localProxy()}>
              <span className={settingsStyles().localProxyEndpoint()}>
                <code>{`${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT}`}</code>
              </span>
              <Button
                disabled={localProxyTest.phase === "pending" || productConnection.stale}
                loading={localProxyTest.phase === "pending"}
                loadingText={LL.settingsPage.localProxy.test()}
                onClick={() => void testLocalProxy()}
                size="sm"
                type="button"
                variant="outline"
              >
                {LL.settingsPage.localProxy.test()}
              </Button>
            </div>
          ) : (
            <AvailabilityBadge availability="unavailable" />
          )}
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.launchProxyWhenMishLaunchesDescription()}
          title={LL.settingsPage.launchProxyWhenMishLaunches()}
        >
          <div className={settingsStyles().inline()}>
            <ToggleGroup
              aria-label={LL.settingsPage.launchProxyWhenMishLaunches()}
              disabled={!launchProxySupported || settings.pending}
              onValueChange={(values) => {
                const option = values[0];
                if (option === "off" || option === "on") {
                  void changeLaunchProxyWhenMishLaunches(option === "on");
                }
              }}
              spacing={0}
              value={[displayedLaunchProxy ? "on" : "off"]}
              variant="segmented"
            >
              <ToggleGroupItem
                aria-busy={pendingButtonAction === "proxy-launch" && !displayedLaunchProxy}
                aria-label={`${LL.settingsPage.launchProxyWhenMishLaunches()}: ${LL.settingsPage.off()}`}
                value="off"
              >
                {LL.settingsPage.off()}
              </ToggleGroupItem>
              <ToggleGroupItem
                aria-busy={pendingButtonAction === "proxy-launch" && displayedLaunchProxy}
                aria-label={`${LL.settingsPage.launchProxyWhenMishLaunches()}: ${LL.settingsPage.on()}`}
                value="on"
              >
                {LL.settingsPage.on()}
              </ToggleGroupItem>
            </ToggleGroup>
            {snapshot.capabilities.backgroundLaunch !== "supported" ? (
              <AvailabilityBadge availability={snapshot.capabilities.backgroundLaunch} />
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.launchAtLoginDescription()}
          title={LL.settingsPage.launchAtLogin()}
        >
          <div className={settingsStyles().inline()}>
            <ToggleGroup
              aria-label={LL.settingsPage.launchAtLogin()}
              disabled={!startupSupported || settings.pending}
              onValueChange={(values) => {
                const option = values[0];
                if (option === "off" || option === "show-window" || option === "background") {
                  void changeStartup(option);
                }
              }}
              spacing={0}
              value={[displayedStartupOption]}
              variant="segmented"
            >
              <ToggleGroupItem
                aria-busy={pendingButtonAction === "startup" && displayedStartupOption === "off"}
                value="off"
              >
                {pendingButtonAction === "startup" && displayedStartupOption === "off" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {LL.settingsPage.off()}
              </ToggleGroupItem>
              <ToggleGroupItem
                aria-busy={
                  pendingButtonAction === "startup" && displayedStartupOption === "show-window"
                }
                value="show-window"
              >
                {pendingButtonAction === "startup" && displayedStartupOption === "show-window" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {LL.settingsPage.showWindow()}
              </ToggleGroupItem>
              <ToggleGroupItem
                aria-busy={
                  pendingButtonAction === "startup" && displayedStartupOption === "background"
                }
                value="background"
              >
                {pendingButtonAction === "startup" && displayedStartupOption === "background" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {LL.settingsPage.background()}
              </ToggleGroupItem>
            </ToggleGroup>
            {snapshot.capabilities.launchAtLogin !== "supported" ? (
              <AvailabilityBadge availability={snapshot.capabilities.launchAtLogin} />
            ) : snapshot.startupRegistration.phase !== "applied" ? (
              <Badge
                variant={
                  snapshot.startupRegistration.phase === "drift" ||
                  snapshot.startupRegistration.phase === "failed"
                    ? "warning"
                    : "outline"
                }
              >
                {LL.settingsPage.registrationPhase[snapshot.startupRegistration.phase]()}
              </Badge>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={LL.settingsPage.networkDescription()}
        id="settings-network"
        title={LL.settingsPage.network()}
      >
        <SettingsRow
          description={networkObservationDescription()}
          title={LL.settingsPage.networkDns.observation()}
        >
          <div className={settingsStyles().inline()}>
            <Badge
              variant={
                network.phase === "ready"
                  ? "success"
                  : network.phase === "failed" || network.phase === "stale"
                    ? "warning"
                    : "outline"
              }
            >
              {LL.settingsPage.networkDns.state[network.phase]()}
            </Badge>
            {networkSupported ? (
              <Button
                disabled={settings.pending}
                loading={loadingPromise("refresh-network")}
                loadingText={LL.settingsPage.networkDns.refresh()}
                onClick={() =>
                  runPromiseButtonAction("refresh-network", settings.refreshNetworkDns)
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {LL.settingsPage.networkDns.refresh()}
              </Button>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.networkPolicyDescription()}
          title={LL.settingsPage.networkPolicy()}
        >
          {network.interfaces.length > 0 ? (
            <span className={settingsStyles().networkList()} data-phase={network.phase}>
              {network.interfaces.map((interfaceState) => (
                <span className={settingsStyles().networkPrimary()} key={interfaceState.interface}>
                  <strong>{interfaceState.service ?? LL.common.unavailable()}</strong>
                  <span>
                    {interfaceState.interface} ·{" "}
                    {LL.settingsPage.networkDns.interfaceKinds[interfaceState.interfaceKind]()}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className={settingsStyles().networkEmpty()}>
              {LL.settingsPage.networkDns.noActiveInterfaces()}
            </span>
          )}
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.networkDns.ipAvailabilityDescription()}
          title={LL.settingsPage.networkDns.ipAvailability()}
        >
          <span className={settingsStyles().networkAddresses()} data-phase={network.phase}>
            {network.interfaces.length > 0
              ? network.interfaces.map((interfaceState) => (
                  <span className={settingsStyles().inline()} key={interfaceState.interface}>
                    <code>{interfaceState.interface}</code>
                    <AddressAvailabilityBadge
                      available={interfaceState.ipv4Available}
                      family="IPv4"
                    />
                    <AddressAvailabilityBadge
                      available={interfaceState.ipv6Available}
                      family="IPv6"
                    />
                  </span>
                ))
              : LL.settingsPage.networkDns.noActiveInterfaces()}
          </span>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.networkDns.serversDescription()}
          title={LL.settingsPage.dns()}
        >
          <div className={settingsStyles().networkDetail()} data-phase={network.phase}>
            <span>
              {network.dns
                ? LL.settingsPage.networkDns.resolverSummary({
                    resolvers: network.dns.resolverCount,
                    scoped: network.dns.scopedResolverCount,
                  })
                : LL.common.unavailable()}
            </span>
            <ObservedValues
              empty={LL.settingsPage.networkDns.noServers()}
              values={network.dns?.servers ?? []}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.networkDns.searchDomainsDescription()}
          title={LL.settingsPage.networkDns.searchDomains()}
        >
          <ObservedValues
            empty={LL.settingsPage.networkDns.noSearchDomains()}
            values={network.dns?.searchDomains ?? []}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={LL.settingsPage.appearanceDescription()}
        id="settings-appearance"
        title={LL.settingsPage.appearance()}
      >
        <SettingsRow
          description={LL.settingsPage.closeWindowDescription()}
          title={LL.settingsPage.closeWindow()}
        >
          <div className={settingsStyles().inline()}>
            <ToggleGroup
              aria-label={LL.settingsPage.closeWindow()}
              disabled={
                snapshot.adapterKind !== "rpc" ||
                snapshot.capabilities.windowLifecycle !== "supported" ||
                settings.pending
              }
              onValueChange={(values) => {
                const behavior = values[0];
                if (behavior === "hide-to-status-bar" || behavior === "quit") {
                  void changeWindowCloseBehavior(behavior);
                }
              }}
              spacing={0}
              value={[optimisticWindowClose ?? snapshot.preferences.windowCloseBehavior]}
              variant="segmented"
            >
              <ToggleGroupItem
                aria-busy={
                  pendingButtonAction === "window-close" &&
                  optimisticWindowClose === "hide-to-status-bar"
                }
                value="hide-to-status-bar"
              >
                {pendingButtonAction === "window-close" &&
                optimisticWindowClose === "hide-to-status-bar" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {LL.settingsPage.hideToStatusBar()}
              </ToggleGroupItem>
              <ToggleGroupItem
                aria-busy={
                  pendingButtonAction === "window-close" && optimisticWindowClose === "quit"
                }
                value="quit"
              >
                {pendingButtonAction === "window-close" && optimisticWindowClose === "quit" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {LL.settingsPage.quitOnClose()}
              </ToggleGroupItem>
            </ToggleGroup>
            {snapshot.capabilities.windowLifecycle !== "supported" ? (
              <AvailabilityBadge availability={snapshot.capabilities.windowLifecycle} />
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow description={LL.settingsPage.themeDescription()} title={LL.appearance.label()}>
          <ToggleGroup
            aria-label={LL.appearance.label()}
            disabled={appearancePending}
            onValueChange={changeAppearance}
            spacing={0}
            value={[preference]}
            variant="segmented"
          >
            {(["system", "light", "dark"] as AppearancePreference[]).map((appearance) => (
              <ToggleGroupItem
                aria-busy={appearancePending && preference === appearance}
                key={appearance}
                value={appearance}
              >
                {appearancePending && preference === appearance ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {LL.appearance[appearance]()}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingsRow>
        {snapshot.capabilities.nativeSidebarMaterial === "supported" ? (
          <SettingsRow
            description={
              windowSurfaceFallbackReason === "reduced-transparency"
                ? LL.settingsPage.windowSurfaceReducedTransparency()
                : LL.settingsPage.windowSurfaceDescription()
            }
            title={LL.settingsPage.windowSurface()}
          >
            <ToggleGroup
              aria-label={LL.settingsPage.windowSurface()}
              disabled={settings.pending || windowSurfacePending}
              onValueChange={changeWindowSurface}
              spacing={0}
              value={[windowSurfacePreference]}
              variant="segmented"
            >
              <ToggleGroupItem
                aria-busy={windowSurfacePending && windowSurfacePreference === "opaque"}
                value="opaque"
              >
                {windowSurfacePending && windowSurfacePreference === "opaque" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {LL.settingsPage.windowSurfaceOpaque()}
              </ToggleGroupItem>
              <ToggleGroupItem
                aria-busy={windowSurfacePending && windowSurfacePreference === "material"}
                value="material"
              >
                {windowSurfacePending && windowSurfacePreference === "material" ? (
                  <Spinner data-icon="inline-start" />
                ) : null}
                {LL.settingsPage.windowSurfaceMaterial()}
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingsRow>
        ) : null}
        <SettingsRow
          description={LL.settingsPage.languageDescription()}
          title={LL.language.label()}
        >
          <ToggleGroup
            aria-label={LL.language.label()}
            disabled={settings.pending}
            onValueChange={(values) => void changeLanguage(values)}
            spacing={0}
            value={[settings.snapshot.preferences.language]}
            variant="segmented"
          >
            <ToggleGroupItem
              aria-busy={pendingButtonAction === "language" && pendingLanguage === "en"}
              value="en"
            >
              {pendingButtonAction === "language" && pendingLanguage === "en" ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {LL.language.english()}
            </ToggleGroupItem>
            <ToggleGroupItem
              aria-busy={pendingButtonAction === "language" && pendingLanguage === "zh-CN"}
              value="zh-CN"
            >
              {pendingButtonAction === "language" && pendingLanguage === "zh-CN" ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {LL.language.simplifiedChinese()}
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={LL.settingsPage.updatesDescription()}
        id="settings-updates"
        title={LL.settingsPage.updatesData()}
      >
        <SettingsRow
          description={LL.settingsPage.softwareUpdatesDescription()}
          title={LL.settingsPage.softwareUpdates()}
        >
          <AvailabilityBadge availability={snapshot.capabilities.updates} />
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.backupDescription()}
          title={LL.settingsPage.backup()}
        >
          <LocalBackupControl />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={LL.settingsPage.advancedDescription()}
        id="settings-advanced"
        title={LL.settingsPage.advancedSupport()}
      >
        <SettingsRow
          description={LL.settingsPage.versionDescription()}
          title={LL.settingsPage.version()}
        >
          <div className={settingsStyles().inline()}>
            <Badge variant="outline">Mish {snapshot.build.appVersion}</Badge>
            <Badge variant="outline">Mihomo {snapshot.build.mihomoVersion}</Badge>
            <Button
              aria-describedby="settings-updates-coming-soon"
              disabled
              size="sm"
              title={LL.settingsPage.comingSoon()}
              type="button"
              variant="outline"
            >
              {LL.settingsPage.checkForUpdates()}
            </Button>
            <span className="sr-only" id="settings-updates-coming-soon">
              {LL.settingsPage.comingSoon()}
            </span>
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
