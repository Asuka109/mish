import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { Info } from "@phosphor-icons/react/Info";
import { Warning } from "@phosphor-icons/react/Warning";
import {
  Badge,
  Button,
  SectionGrid,
  SectionGridItem,
  Spinner,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import type {
  AppearancePreference,
  CaptureSelectionDto,
  ConfirmationState,
  LanguagePreference,
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
import { useI18nContext } from "../i18n/i18n-react";
import { isLocale } from "../i18n/i18n-util";
import { persistLocale } from "../i18n/locale";
import { useEffect, useRef, useState, type ReactNode } from "react";

type PendingButtonAction = "language" | "launch-at-login" | "login-behavior" | "window-close";

type PromiseButtonAction = "install-helper" | "refresh-network" | "remove-helper" | "repair-helper";

function AvailabilityBadge({ availability }: { availability: SettingsAvailability }) {
  const { LL } = useI18nContext();
  const label =
    availability === "supported"
      ? LL.settingsPage.available()
      : availability === "coming-later"
        ? LL.settingsPage.comingLater()
        : LL.common.unavailable();
  return <Badge variant={availability === "supported" ? "success" : "outline"}>{label}</Badge>;
}

function Confirmation({ state }: { state: ConfirmationState }) {
  const { LL } = useI18nContext();
  const Icon = state === "confirmed" ? CheckCircle : Info;
  return (
    <span className="settings-confirmation" data-confirmed={state === "confirmed"}>
      <Icon aria-hidden="true" weight="fill" />
      {state === "confirmed" ? LL.settingsPage.confirmed() : LL.common.unavailable()}
    </span>
  );
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
    promise: Promise<boolean>;
  } | null>(null);
  const [optimisticCaptureSelection, setOptimisticCaptureSelection] =
    useState<CaptureSelectionDto | null>(null);
  const [pendingCaptureMode, setPendingCaptureMode] = useState<"systemProxy" | "tun" | null>(null);
  const [optimisticStartup, setOptimisticStartup] = useState<StartupPreferencesDto | null>(null);
  const [optimisticWindowClose, setOptimisticWindowClose] = useState<WindowCloseBehavior | null>(
    null,
  );
  const [pendingLanguage, setPendingLanguage] = useState<LanguagePreference | null>(null);
  const networkAutoRefreshStarted = useRef(false);
  const { LL, locale, setLocale } = useI18nContext();
  const snapshot = settings.snapshot;
  const startup = snapshot.preferences.startup;
  const displayedStartup = optimisticStartup ?? startup;
  const captureSupported = isCommandSupported("capture");
  const captureRuntime = product?.runtime;
  const captureActive = Boolean(captureRuntime?.systemProxyEnabled || captureRuntime?.tunEnabled);
  const startupSupported =
    snapshot.adapterKind === "rpc" && snapshot.capabilities.launchAtLogin === "supported";
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

  function runPromiseButtonAction(action: PromiseButtonAction, operation: () => Promise<boolean>) {
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

  async function changeStartup(
    action: "launch-at-login" | "login-behavior",
    nextStartup: StartupPreferencesDto,
  ) {
    setPendingButtonAction(action);
    setOptimisticStartup(nextStartup);
    try {
      await settings.setStartup(nextStartup);
    } finally {
      setPendingButtonAction(null);
      setOptimisticStartup(null);
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
    <div className="settings-page page-scroll">
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
                onClick={() => runPromiseButtonAction("install-helper", settings.installTunHelper)}
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
                disabled={settings.pending || captureRuntime?.tunEnabled}
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
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.localProxy.description()}
          title={LL.settingsPage.localProxy.title()}
        >
          {product?.adapterKind === "rpc" ? (
            <div className="local-proxy-control">
              <span className="local-proxy-endpoint">
                <code>{`${LOCAL_PROXY_HOST}:${LOCAL_PROXY_PORT}`}</code>
                <Badge variant="outline">HTTP</Badge>
                <Badge variant="outline">SOCKS5</Badge>
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
          description={LL.settingsPage.launchAtLoginDescription()}
          title={LL.settingsPage.launchAtLogin()}
        >
          <div className="settings-inline-control">
            <Toggle
              aria-busy={pendingButtonAction === "launch-at-login"}
              aria-label={LL.settingsPage.launchAtLogin()}
              className="settings-switch"
              disabled={!startupSupported || settings.pending}
              onPressedChange={(launchAtLogin) =>
                void changeStartup("launch-at-login", { ...startup, launchAtLogin })
              }
              pressed={displayedStartup.launchAtLogin}
              variant="outline"
            >
              {pendingButtonAction === "launch-at-login" ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {displayedStartup.launchAtLogin ? LL.settingsPage.on() : LL.settingsPage.off()}
            </Toggle>
            <AvailabilityBadge availability={snapshot.capabilities.launchAtLogin} />
          </div>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.loginWindowDescription()}
          title={LL.settingsPage.loginWindow()}
        >
          <ToggleGroup
            aria-label={LL.settingsPage.loginWindow()}
            className="settings-segmented"
            disabled={!startupSupported || !displayedStartup.launchAtLogin || settings.pending}
            onValueChange={(values) => {
              const behavior = values[0];
              if (behavior === "show-window" || behavior === "background") {
                void changeStartup("login-behavior", {
                  ...startup,
                  loginLaunchBehavior: behavior,
                });
              }
            }}
            spacing={0}
            value={[displayedStartup.loginLaunchBehavior]}
            variant="outline"
          >
            <ToggleGroupItem
              aria-busy={
                pendingButtonAction === "login-behavior" &&
                displayedStartup.loginLaunchBehavior === "show-window"
              }
              value="show-window"
            >
              {pendingButtonAction === "login-behavior" &&
              displayedStartup.loginLaunchBehavior === "show-window" ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {LL.settingsPage.showWindow()}
            </ToggleGroupItem>
            <ToggleGroupItem
              aria-busy={
                pendingButtonAction === "login-behavior" &&
                displayedStartup.loginLaunchBehavior === "background"
              }
              value="background"
            >
              {pendingButtonAction === "login-behavior" &&
              displayedStartup.loginLaunchBehavior === "background" ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {LL.settingsPage.background()}
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.registrationDescription()}
          title={LL.settingsPage.registration()}
        >
          <Badge
            variant={
              snapshot.startupRegistration.phase === "applied"
                ? "success"
                : snapshot.startupRegistration.phase === "drift" ||
                    snapshot.startupRegistration.phase === "failed"
                  ? "warning"
                  : "outline"
            }
          >
            {LL.settingsPage.registrationPhase[snapshot.startupRegistration.phase]()}
          </Badge>
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
                    <Badge variant={interfaceState.ipv4Available ? "success" : "outline"}>
                      IPv4 ·{" "}
                      {interfaceState.ipv4Available
                        ? LL.settingsPage.available()
                        : LL.common.unavailable()}
                    </Badge>
                    <Badge variant={interfaceState.ipv6Available ? "success" : "outline"}>
                      IPv6 ·{" "}
                      {interfaceState.ipv6Available
                        ? LL.settingsPage.available()
                        : LL.common.unavailable()}
                    </Badge>
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
            <AvailabilityBadge availability={snapshot.capabilities.windowLifecycle} />
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
        <SettingsRow
          description={LL.settingsPage.motionDescription()}
          title={LL.settingsPage.motion()}
        >
          <Badge variant="outline">{LL.settingsPage.followsSystem()}</Badge>
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
        description={LL.settingsPage.privacyDescription()}
        id="settings-privacy"
        title={LL.settingsPage.privacyAccess()}
      >
        <SettingsRow
          description={LL.settingsPage.loopbackDescription()}
          title={LL.settingsPage.loopback()}
        >
          <Confirmation state={snapshot.privacy.loopbackOnly} />
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.authenticationDescription()}
          title={LL.settingsPage.authentication()}
        >
          <Confirmation state={snapshot.privacy.authenticated} />
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.originDescription()}
          title={LL.settingsPage.origin()}
        >
          <Confirmation state={snapshot.privacy.originValidated} />
        </SettingsRow>
        <SettingsRow description={LL.settingsPage.lanDescription()} title={LL.settingsPage.lan()}>
          <AvailabilityBadge availability={snapshot.privacy.lanControl} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={LL.settingsPage.advancedDescription()}
        id="settings-advanced"
        title={LL.settingsPage.advancedSupport()}
      >
        <SettingsRow
          description={LL.settingsPage.expertDescription()}
          title={LL.settingsPage.expert()}
        >
          <AvailabilityBadge availability={snapshot.capabilities.expertConfiguration} />
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.versionDescription()}
          title={LL.settingsPage.version()}
        >
          <span className="settings-version">Mish 0.1.0</span>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
