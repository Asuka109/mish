import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { Info } from "@phosphor-icons/react/Info";
import { Warning } from "@phosphor-icons/react/Warning";
import {
  Badge,
  SectionGrid,
  SectionGridItem,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import type {
  AppearancePreference,
  ConfirmationState,
  LanguagePreference,
  SettingsAvailability,
} from "@mish/contracts";
import { TrafficCaptureControl } from "../components/traffic-capture-control";
import { useAppearance } from "../appearance";
import { useProduct } from "../data/product-provider";
import { useSettings } from "../data/settings-provider";
import { useI18nContext } from "../i18n/i18n-react";
import { isLocale } from "../i18n/i18n-util";
import { persistLocale } from "../i18n/locale";
import type { ReactNode } from "react";

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

export function SettingsPage() {
  const { preference, setPreference } = useAppearance();
  const {
    error: productError,
    isCommandPending,
    isCommandSupported,
    recoverSystemProxy,
    setCapture,
    snapshot: product,
  } = useProduct();
  const settings = useSettings();
  const { LL, locale, setLocale } = useI18nContext();
  const snapshot = settings.snapshot;
  const startup = snapshot.preferences.startup;
  const capturePending = isCommandPending("capture");
  const captureSupported = isCommandSupported("capture");
  const captureRuntime = product?.runtime;
  const captureActive = Boolean(captureRuntime?.systemProxyEnabled || captureRuntime?.tunEnabled);
  const startupSupported =
    snapshot.adapterKind === "rpc" && snapshot.capabilities.launchAtLogin === "supported";

  function changeCaptureMode(mode: "systemProxy" | "tun", selected: boolean) {
    if (!captureRuntime || !captureSupported) return;
    const selection = { ...captureRuntime.captureSelection, [mode]: selected };
    const active = captureActive ? selection.systemProxy || selection.tun : selected;
    void setCapture(selection, active);
  }

  async function changeLanguage(values: string[]) {
    const language = values[0];
    if (!language || !isLocale(language)) return;
    if (!(await settings.setLanguage(language))) return;
    persistLocale(language);
    setLocale(language);
  }

  function changeAppearance(values: string[]) {
    const appearance = values[0] as AppearancePreference | undefined;
    if (!appearance || !["system", "light", "dark"].includes(appearance)) return;
    setPreference(appearance);
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

      {settings.error || productError ? (
        <p className="fixture-error" role="alert">
          {LL.settingsPage.updateFailed()}
        </p>
      ) : null}
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
              capabilities={{ ...product.capabilities, tun: "unavailable" }}
              commandSupported={captureSupported}
              disabled={capturePending || captureRuntime.systemProxy.recoveryActions.length > 0}
              onSystemProxyChange={(selected) => changeCaptureMode("systemProxy", selected)}
              onSystemProxyRecovery={(action) => void recoverSystemProxy(action)}
              onTunChange={(selected) => changeCaptureMode("tun", selected)}
              pending={capturePending}
              systemProxyEnabled={captureRuntime.systemProxyEnabled}
              systemProxySelected={captureRuntime.captureSelection.systemProxy}
              systemProxyStatus={captureRuntime.systemProxy}
              tunEnabled={captureRuntime.tunEnabled}
              tunSelected={captureRuntime.captureSelection.tun}
            />
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
              aria-label={LL.settingsPage.launchAtLogin()}
              className="settings-switch"
              disabled={!startupSupported || settings.pending}
              onPressedChange={(launchAtLogin) =>
                void settings.setStartup({ ...startup, launchAtLogin })
              }
              pressed={startup.launchAtLogin}
              variant="outline"
            >
              {startup.launchAtLogin ? LL.settingsPage.on() : LL.settingsPage.off()}
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
            disabled={!startupSupported || !startup.launchAtLogin || settings.pending}
            onValueChange={(values) => {
              const behavior = values[0];
              if (behavior === "show-window" || behavior === "background") {
                void settings.setStartup({ ...startup, loginLaunchBehavior: behavior });
              }
            }}
            spacing={0}
            value={[startup.loginLaunchBehavior]}
            variant="outline"
          >
            <ToggleGroupItem value="show-window">{LL.settingsPage.showWindow()}</ToggleGroupItem>
            <ToggleGroupItem value="background">{LL.settingsPage.background()}</ToggleGroupItem>
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
        <SettingsRow description={LL.settingsPage.dnsDescription()} title={LL.settingsPage.dns()}>
          <AvailabilityBadge availability={snapshot.capabilities.networkDns} />
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.networkPolicyDescription()}
          title={LL.settingsPage.networkPolicy()}
        >
          <AvailabilityBadge availability={snapshot.capabilities.networkDns} />
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
                  void settings.setWindowCloseBehavior(behavior);
                }
              }}
              spacing={0}
              value={[snapshot.preferences.windowCloseBehavior]}
              variant="outline"
            >
              <ToggleGroupItem value="hide-to-status-bar">
                {LL.settingsPage.hideToStatusBar()}
              </ToggleGroupItem>
              <ToggleGroupItem value="quit">{LL.settingsPage.quitOnClose()}</ToggleGroupItem>
            </ToggleGroup>
            <AvailabilityBadge availability={snapshot.capabilities.windowLifecycle} />
          </div>
        </SettingsRow>
        <SettingsRow description={LL.settingsPage.themeDescription()} title={LL.appearance.label()}>
          <ToggleGroup
            aria-label={LL.appearance.label()}
            className="settings-segmented"
            onValueChange={changeAppearance}
            spacing={0}
            value={[preference]}
            variant="outline"
          >
            {(["system", "light", "dark"] as AppearancePreference[]).map((appearance) => (
              <ToggleGroupItem key={appearance} value={appearance}>
                {LL.appearance[appearance]()}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingsRow>
        <SettingsRow
          description={LL.settingsPage.languageDescription()}
          title={LL.language.label()}
        >
          <ToggleGroup
            aria-label={LL.language.label()}
            className="settings-segmented"
            onValueChange={(values) => void changeLanguage(values)}
            spacing={0}
            value={[locale satisfies LanguagePreference]}
            variant="outline"
          >
            <ToggleGroupItem value="en">{LL.language.english()}</ToggleGroupItem>
            <ToggleGroupItem value="zh">{LL.language.simplifiedChinese()}</ToggleGroupItem>
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
          <AvailabilityBadge availability={snapshot.capabilities.backupRestore} />
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
