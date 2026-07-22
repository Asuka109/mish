import { Warning } from "@phosphor-icons/react/Warning";
import {
  Badge,
  Button,
  SectionGrid,
  SectionGridItem,
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
import { isLocale } from "../i18n/i18n-util";
import { persistLocale } from "../i18n/locale";
import { useEffect, useRef, useState, type ReactNode } from "react";

type PendingButtonAction =
  | "language"
  | "managed-ports"
  | "proxy-launch"
  | "startup"
  | "window-close";

type StartupOption = "off" | "show-window" | "background";

type PromiseButtonAction =
  | "install-helper"
  | "refresh-network"
  | "reinstall-helper"
  | "remove-helper"
  | "repair-helper";

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
    <section aria-labelledby={id} className="settings-section">
      <div className="settings-section-heading">
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
      <SectionGrid className="settings-group">{children}</SectionGrid>
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
    <SectionGridItem className="settings-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="settings-row-control">{children}</div>
    </SectionGridItem>
  );
}

function ObservedValues({ empty, values }: { empty: string; values: string[] }) {
  if (values.length === 0) return <span className="network-dns-empty">{empty}</span>;
  return (
    <span className="network-dns-values">
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
  const [optimisticWindowClose, setOptimisticWindowClose] = useState<WindowCloseBehavior | null>(
    null,
  );
  const [pendingLanguage, setPendingLanguage] = useState<LanguagePreference | null>(null);
  const [managedPorts, setManagedPorts] = useState<ManagedPortPreferencesDto | null>(null);
  const networkAutoRefreshStarted = useRef(false);
  const { LL, locale, setLocale } = useI18nContext();
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
    if (!language || !isLocale(language)) return;
    setPendingButtonAction("language");
    setPendingLanguage(language);
    try {
      if (!(await settings.setLanguage(language))) return;
      persistLocale(language);
      setLocale(language);
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
    <div className="settings-page">
      <header className="settings-header">
        <h1>{LL.settingsPage.title()}</h1>
        <p>
          {snapshot.adapterKind === "fixture"
            ? LL.settingsPage.fixtureDescription()
            : LL.settingsPage.description()}
        </p>
      </header>

      {snapshot.storageRecovered ? (
        <p className="settings-notice" role="status">
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
          <div className="settings-inline-control">
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
              onTunHelperInstall={settings.installTunHelper}
              onTunChange={(selected) => changeCaptureMode("tun", selected)}
              pending={capturePending}
              pendingMode={pendingCaptureMode}
              systemProxyEnabled={captureRuntime.systemProxyEnabled}
              systemProxySelected={
                optimisticCaptureSelection?.systemProxy ??
                captureRuntime.captureSelection.systemProxy
              }
              systemProxyStatus={captureRuntime.systemProxy}
              tunEnabled={captureRuntime.tunEnabled}
              tunGuideIdentity={
                helper.installationId ?? helper.installedVersion ?? helper.expectedVersion
              }
              tunHelperReady={helperAvailable}
              tunSelected={optimisticCaptureSelection?.tun ?? captureRuntime.captureSelection.tun}
              tunStatus={captureRuntime.tun}
            />
          ) : (
            <AvailabilityBadge availability="unavailable" />
          )}
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.tunHelperDescription()}
          title={LL.settingsPage.tunHelper()}
        >
          <div>
            <div className="settings-inline-control">
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
            <div className="local-proxy-control">
              <span className="local-proxy-endpoint">
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
          <div className="settings-inline-control">
            <ToggleGroup
              aria-label={LL.settingsPage.launchProxyWhenMishLaunches()}
              className="settings-segmented"
              disabled={!launchProxySupported || settings.pending}
              onValueChange={(values) => {
                const option = values[0];
                if (option === "off" || option === "on") {
                  void changeLaunchProxyWhenMishLaunches(option === "on");
                }
              }}
              spacing={0}
              value={[displayedLaunchProxy ? "on" : "off"]}
              variant="outline"
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
          <div className="settings-inline-control">
            <ToggleGroup
              aria-label={LL.settingsPage.launchAtLogin()}
              className="settings-segmented"
              disabled={!startupSupported || settings.pending}
              onValueChange={(values) => {
                const option = values[0];
                if (option === "off" || option === "show-window" || option === "background") {
                  void changeStartup(option);
                }
              }}
              spacing={0}
              value={[displayedStartupOption]}
              variant="outline"
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
          <div className="settings-inline-control">
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
            <span className="network-interface-list" data-phase={network.phase}>
              {network.interfaces.map((interfaceState) => (
                <span className="network-dns-primary" key={interfaceState.interface}>
                  <strong>{interfaceState.service ?? LL.common.unavailable()}</strong>
                  <span>
                    {interfaceState.interface} ·{" "}
                    {LL.settingsPage.networkDns.interfaceKinds[interfaceState.interfaceKind]()}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className="network-dns-empty">
              {LL.settingsPage.networkDns.noActiveInterfaces()}
            </span>
          )}
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.networkDns.ipAvailabilityDescription()}
          title={LL.settingsPage.networkDns.ipAvailability()}
        >
          <span className="network-interface-addresses" data-phase={network.phase}>
            {network.interfaces.length > 0
              ? network.interfaces.map((interfaceState) => (
                  <span className="settings-inline-control" key={interfaceState.interface}>
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
          <div className="network-dns-detail" data-phase={network.phase}>
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
          <div className="settings-inline-control">
            <ToggleGroup
              aria-label={LL.settingsPage.closeWindow()}
              className="settings-segmented"
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
              variant="outline"
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
            className="settings-segmented"
            disabled={appearancePending}
            onValueChange={changeAppearance}
            spacing={0}
            value={[preference]}
            variant="outline"
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
              className="settings-segmented"
              disabled={settings.pending || windowSurfacePending}
              onValueChange={changeWindowSurface}
              spacing={0}
              value={[windowSurfacePreference]}
              variant="outline"
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
            className="settings-segmented"
            disabled={settings.pending}
            onValueChange={(values) => void changeLanguage(values)}
            spacing={0}
            value={[locale satisfies LanguagePreference]}
            variant="outline"
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
              aria-busy={pendingButtonAction === "language" && pendingLanguage === "zh"}
              value="zh"
            >
              {pendingButtonAction === "language" && pendingLanguage === "zh" ? (
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
          <div className="settings-inline-control">
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
