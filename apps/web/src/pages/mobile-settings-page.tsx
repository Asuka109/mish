import type {
  LanguagePreference,
  MobileVpnPhase,
  MobileVpnSnapshotDto,
  SettingsAvailability,
} from "@mish/contracts";
import {
  Badge,
  SectionGridItem,
  SettingsGroup,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { Link, Navigate, useParams } from "react-router";
import { useState, type ReactNode } from "react";
import { cx, tv } from "@mish/ui/tv";
import { useAppearance } from "../appearance";
import { useMobileVpnSnapshot } from "../data/mobile-vpn-snapshot";
import { useSettings } from "../data/settings-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";

const mobileSettingsStyles = tv({
  slots: {
    page: cx(
      "mobile-settings-page h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain scroll-pb-8",
      "px-4 pt-4 pb-8",
    ),
    content: "mx-auto grid w-full max-w-130 min-w-0 gap-5",
    header: cx(
      "grid gap-1 px-1",
      "[&_h2]:text-body [&_h2]:leading-5 [&_h2]:font-semibold [&_p]:text-metadata",
      "[&_p]:leading-4.5 [&_p]:text-muted-foreground",
    ),
    category: cx(
      "mobile-settings-category flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start",
      "text-fg no-underline active:bg-accent focus-visible:bg-accent",
    ),
    categoryCopy: "grid min-w-0 flex-1 gap-0.5",
    categoryTitle: "text-body leading-5 font-medium text-ink",
    categoryDescription: "text-metadata leading-4.5 text-muted-foreground",
    categoryChevron: "shrink-0 text-muted-foreground [&_svg]:size-4.5",
    row: cx(
      "grid min-h-16 grid-cols-1 items-center gap-3 px-4 py-3",
      "sm:grid-cols-[minmax(0,1fr)_minmax(0,max-content)] sm:gap-4",
    ),
    rowCopy: "grid min-w-0 gap-0.5",
    rowTitle: "text-body leading-5 font-medium text-fg",
    rowDescription: "text-metadata leading-4.5 text-muted-foreground",
    rowValue:
      "min-w-0 max-w-full break-words text-start text-metadata leading-4.5 font-medium text-muted-foreground sm:text-end",
    segmented: "max-w-full [&_button]:min-h-11 [&_button]:px-3",
    feedback: cx(
      "rounded-md border border-feedback-warning-border bg-badge-warning-background px-3 py-2",
      "text-metadata leading-4.5 text-warning",
    ),
    action: cx(
      "inline-flex min-h-11 items-center justify-center rounded-md border border-hairline bg-canvas px-4",
      "text-metadata font-medium text-fg no-underline active:bg-accent focus-visible:bg-accent",
    ),
  },
});

type MobileSettingsSection =
  | "application"
  | "vpn"
  | "network"
  | "privacy"
  | "updates"
  | "diagnostics"
  | "recovery";

interface MobileSettingsProps {
  initialSnapshot: MobileVpnSnapshotDto;
  vpnClient: MobileVpnClient;
}

interface MobileSettingsDetailProps extends MobileSettingsProps {
  section: MobileSettingsSection;
}

interface MobileSettingsDetailFrameProps extends MobileSettingsDetailProps {
  children(context: {
    settings: ReturnType<typeof useSettings>;
    snapshot: MobileVpnSnapshotDto;
  }): ReactNode;
}

function isMobileSettingsSection(value: string | undefined): value is MobileSettingsSection {
  return [
    "application",
    "vpn",
    "network",
    "privacy",
    "updates",
    "diagnostics",
    "recovery",
  ].includes(value ?? "");
}

function phaseLabel(LL: TranslationFunctions, phase: MobileVpnPhase) {
  switch (phase) {
    case "failed":
      return LL.mobileHome.failedState();
    case "permission-required":
      return LL.mobileHome.permissionRequiredState();
    case "recovery-required":
      return LL.mobileHome.recoveryState();
    case "running":
      return LL.mobileHome.runningState();
    case "starting":
      return LL.mobileHome.startingState();
    case "stopped":
      return LL.mobileHome.stoppedState();
    case "stopping":
      return LL.mobileHome.stoppingState();
    case "unavailable":
      return LL.mobileHome.unavailableState();
  }
}

function phaseVariant(phase: MobileVpnPhase) {
  if (phase === "running") return "success" as const;
  if (phase === "failed" || phase === "recovery-required") return "destructive" as const;
  if (phase === "permission-required" || phase === "starting" || phase === "stopping") {
    return "warning" as const;
  }
  return "outline" as const;
}

function availabilityLabel(LL: TranslationFunctions, availability: SettingsAvailability) {
  if (availability === "supported") return LL.mobileSettings.available();
  if (availability === "coming-later") return LL.mobileSettings.comingLater();
  return LL.common.unavailable();
}

function availabilityVariant(availability: SettingsAvailability) {
  return availability === "supported" ? ("success" as const) : ("outline" as const);
}

function observationLabel(LL: TranslationFunctions, observed: boolean) {
  return observed ? LL.mobileSettings.observed() : LL.mobileSettings.notObserved();
}

function configurationLabel(LL: TranslationFunctions, snapshot: MobileVpnSnapshotDto) {
  if (snapshot.coreConfigState === "loaded" && snapshot.loadedConfigRevision) {
    return LL.mobileHome.configLoadedValue({ revision: snapshot.loadedConfigRevision });
  }
  if (snapshot.coreConfigState === "unknown") return LL.mobileHome.configUnknownValue();
  if (snapshot.validatedConfigRevision) {
    return LL.mobileHome.configValidatedValue({ revision: snapshot.validatedConfigRevision });
  }
  return LL.mobileHome.configUnloadedValue();
}

function MobileSettingsHeader({ description, title }: { description: string; title: string }) {
  const styles = mobileSettingsStyles();
  return (
    <header className={styles.header()}>
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function MobileSettingsRow({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  const styles = mobileSettingsStyles();
  return (
    <SectionGridItem className={styles.row()}>
      <div className={styles.rowCopy()}>
        <strong className={styles.rowTitle()}>{title}</strong>
        <span className={styles.rowDescription()}>{description}</span>
      </div>
      <div className={styles.rowValue()}>{children}</div>
    </SectionGridItem>
  );
}

function MobileSettingsDetail({ children, ...props }: MobileSettingsDetailFrameProps) {
  const { LL } = useI18nContext();
  const snapshot = useMobileVpnSnapshot(props.vpnClient, props.initialSnapshot);
  const settings = useSettings();
  const styles = mobileSettingsStyles();
  const detail = detailCopy(LL, props.section);

  return (
    <div className={styles.page()}>
      <div className={styles.content()}>
        <MobileSettingsHeader description={detail.description} title={detail.title} />
        {children({ settings, snapshot })}
      </div>
    </div>
  );
}

function detailCopy(LL: TranslationFunctions, section: MobileSettingsSection) {
  switch (section) {
    case "application":
      return {
        description: LL.mobileSettings.applicationDescription(),
        title: LL.mobileSettings.application(),
      };
    case "vpn":
      return { description: LL.mobileSettings.vpnDescription(), title: LL.mobileSettings.vpn() };
    case "network":
      return {
        description: LL.mobileSettings.networkDescription(),
        title: LL.mobileSettings.network(),
      };
    case "privacy":
      return {
        description: LL.mobileSettings.privacyDescription(),
        title: LL.mobileSettings.privacy(),
      };
    case "updates":
      return {
        description: LL.mobileSettings.updatesDescription(),
        title: LL.mobileSettings.updates(),
      };
    case "diagnostics":
      return {
        description: LL.mobileSettings.diagnosticsDescription(),
        title: LL.mobileSettings.diagnostics(),
      };
    case "recovery":
      return {
        description: LL.mobileSettings.recoveryDescription(),
        title: LL.mobileSettings.recovery(),
      };
  }
}

export function MobileSettingsPage({ initialSnapshot, vpnClient }: MobileSettingsProps) {
  const { LL } = useI18nContext();
  const snapshot = useMobileVpnSnapshot(vpnClient, initialSnapshot);
  const settings = useSettings();
  const styles = mobileSettingsStyles();
  const sections: Array<{
    description: string;
    section: MobileSettingsSection;
    title: string;
  }> = [
    {
      description: LL.mobileSettings.applicationSummary(),
      section: "application",
      title: LL.mobileSettings.application(),
    },
    {
      description: phaseLabel(LL, snapshot.phase),
      section: "vpn",
      title: LL.mobileSettings.vpn(),
    },
    {
      description: LL.mobileSettings.networkSummary(),
      section: "network",
      title: LL.mobileSettings.network(),
    },
    {
      description: LL.mobileSettings.privacySummary(),
      section: "privacy",
      title: LL.mobileSettings.privacy(),
    },
    {
      description: availabilityLabel(LL, settings.snapshot.capabilities.updates),
      section: "updates",
      title: LL.mobileSettings.updates(),
    },
    {
      description: configurationLabel(LL, snapshot),
      section: "diagnostics",
      title: LL.mobileSettings.diagnostics(),
    },
    {
      description: phaseLabel(LL, snapshot.phase),
      section: "recovery",
      title: LL.mobileSettings.recovery(),
    },
  ];

  return (
    <div className={styles.page()}>
      <div className={styles.content()}>
        <MobileSettingsHeader
          description={LL.mobileSettings.rootDescription()}
          title={LL.mobileSettings.title()}
        />
        <SettingsGroup aria-label={LL.mobileSettings.title()}>
          {sections.map((section) => (
            <SectionGridItem key={section.section}>
              <Link
                aria-describedby={`mobile-settings-${section.section}-description`}
                aria-label={section.title}
                className={styles.category()}
                to={`/settings/${section.section}`}
              >
                <span className={styles.categoryCopy()}>
                  <strong className={styles.categoryTitle()}>{section.title}</strong>
                  <span
                    className={styles.categoryDescription()}
                    id={`mobile-settings-${section.section}-description`}
                  >
                    {section.description}
                  </span>
                </span>
                <span aria-hidden="true" className={styles.categoryChevron()}>
                  <CaretRight />
                </span>
              </Link>
            </SectionGridItem>
          ))}
        </SettingsGroup>
      </div>
    </div>
  );
}

export function MobileSettingsDetailPage({ initialSnapshot, vpnClient }: MobileSettingsProps) {
  const { section } = useParams();
  if (!isMobileSettingsSection(section)) return <Navigate replace to="/settings" />;

  if (section === "application") {
    return (
      <MobileApplicationSettings
        initialSnapshot={initialSnapshot}
        section={section}
        vpnClient={vpnClient}
      />
    );
  }
  if (section === "vpn") {
    return (
      <MobileVpnSettings
        initialSnapshot={initialSnapshot}
        section={section}
        vpnClient={vpnClient}
      />
    );
  }
  if (section === "network") {
    return (
      <MobileNetworkSettings
        initialSnapshot={initialSnapshot}
        section={section}
        vpnClient={vpnClient}
      />
    );
  }
  if (section === "privacy") {
    return (
      <MobilePrivacySettings
        initialSnapshot={initialSnapshot}
        section={section}
        vpnClient={vpnClient}
      />
    );
  }
  if (section === "updates") {
    return (
      <MobileUpdatesSettings
        initialSnapshot={initialSnapshot}
        section={section}
        vpnClient={vpnClient}
      />
    );
  }
  if (section === "diagnostics") {
    return (
      <MobileDiagnosticsSettings
        initialSnapshot={initialSnapshot}
        section={section}
        vpnClient={vpnClient}
      />
    );
  }
  return (
    <MobileRecoverySettings
      initialSnapshot={initialSnapshot}
      section={section}
      vpnClient={vpnClient}
    />
  );
}

function MobileApplicationSettings(props: MobileSettingsDetailProps) {
  const { LL } = useI18nContext();
  const { appearancePending, preference, setPreference } = useAppearance();
  const settings = useSettings();
  const [pendingLanguage, setPendingLanguage] = useState<LanguagePreference | null>(null);
  const styles = mobileSettingsStyles();

  async function changeLanguage(language: LanguagePreference) {
    if (language === settings.snapshot.preferences.language || settings.pending) return;
    setPendingLanguage(language);
    try {
      await settings.setLanguage(language);
    } finally {
      setPendingLanguage(null);
    }
  }

  return (
    <MobileSettingsDetail {...props}>
      {() => (
        <>
          <SettingsGroup aria-label={LL.mobileSettings.application()}>
            <MobileSettingsRow
              description={LL.mobileSettings.appearanceDescription()}
              title={LL.appearance.label()}
            >
              <ToggleGroup
                aria-label={LL.appearance.label()}
                className={styles.segmented()}
                disabled={appearancePending || settings.pending}
                onValueChange={(values) => {
                  const appearance = values[0];
                  if (appearance === "system" || appearance === "light" || appearance === "dark") {
                    setPreference(appearance);
                  }
                }}
                spacing={0}
                value={[preference]}
                variant="segmented"
              >
                {(["system", "light", "dark"] as const).map((appearance) => (
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
            </MobileSettingsRow>
            <MobileSettingsRow
              description={LL.mobileSettings.languageDescription()}
              title={LL.language.label()}
            >
              <ToggleGroup
                aria-label={LL.language.label()}
                className={styles.segmented()}
                disabled={settings.pending}
                onValueChange={(values) => {
                  const language = values[0];
                  if (language === "en" || language === "zh-CN") void changeLanguage(language);
                }}
                spacing={0}
                value={[settings.snapshot.preferences.language]}
                variant="segmented"
              >
                <ToggleGroupItem aria-busy={pendingLanguage === "en"} value="en">
                  {pendingLanguage === "en" ? <Spinner data-icon="inline-start" /> : null}
                  {LL.language.english()}
                </ToggleGroupItem>
                <ToggleGroupItem aria-busy={pendingLanguage === "zh-CN"} value="zh-CN">
                  {pendingLanguage === "zh-CN" ? <Spinner data-icon="inline-start" /> : null}
                  {LL.language.simplifiedChinese()}
                </ToggleGroupItem>
              </ToggleGroup>
            </MobileSettingsRow>
          </SettingsGroup>
          {appearancePending || pendingLanguage ? (
            <p className={styles.feedback()} role="status">
              {LL.mobileSettings.settingPending()}
            </p>
          ) : null}
          {settings.error ? (
            <p className={styles.feedback()} role="status">
              {LL.mobileSettings.settingFailed()}
            </p>
          ) : null}
        </>
      )}
    </MobileSettingsDetail>
  );
}

function MobileVpnSettings(props: MobileSettingsDetailProps) {
  const { LL } = useI18nContext();
  const styles = mobileSettingsStyles();
  return (
    <MobileSettingsDetail {...props}>
      {({ snapshot }) => (
        <>
          <SettingsGroup aria-label={LL.mobileSettings.vpn()}>
            <MobileSettingsRow
              description={snapshot.message}
              title={LL.mobileSettings.currentState()}
            >
              <Badge variant={phaseVariant(snapshot.phase)}>{phaseLabel(LL, snapshot.phase)}</Badge>
            </MobileSettingsRow>
            <MobileSettingsRow
              description={LL.mobileSettings.vpnPermissionDescription()}
              title={LL.mobileSettings.vpnPermission()}
            >
              {snapshot.permission === "granted"
                ? LL.mobileSettings.permissionGranted()
                : snapshot.permission === "required"
                  ? LL.mobileSettings.permissionRequired()
                  : LL.common.unavailable()}
            </MobileSettingsRow>
            <MobileSettingsRow
              description={LL.mobileSettings.foregroundDescription()}
              title={LL.mobileSettings.foreground()}
            >
              {observationLabel(LL, snapshot.foreground)}
            </MobileSettingsRow>
          </SettingsGroup>
          <Link className={styles.action()} to="/status">
            {LL.mobileSettings.manageOnHome()}
          </Link>
        </>
      )}
    </MobileSettingsDetail>
  );
}

function MobileNetworkSettings(props: MobileSettingsDetailProps) {
  const { LL } = useI18nContext();
  return (
    <MobileSettingsDetail {...props}>
      {({ snapshot }) => (
        <SettingsGroup aria-label={LL.mobileSettings.network()}>
          <MobileSettingsRow
            description={LL.mobileSettings.underlyingNetworkDescription()}
            title={LL.mobileSettings.underlyingNetwork()}
          >
            {observationLabel(LL, snapshot.activeNetwork)}
          </MobileSettingsRow>
          <MobileSettingsRow
            description={LL.mobileSettings.routesDescription()}
            title={LL.mobileSettings.routes()}
          >
            {observationLabel(LL, snapshot.routesApplied)}
          </MobileSettingsRow>
          <MobileSettingsRow
            description={LL.mobileSettings.dnsDescription()}
            title={LL.mobileSettings.dns()}
          >
            {observationLabel(LL, snapshot.dnsApplied)}
          </MobileSettingsRow>
          <MobileSettingsRow
            description={LL.mobileSettings.publicRequestDescription()}
            title={LL.mobileSettings.publicRequest()}
          >
            {observationLabel(LL, snapshot.publicRequestObserved)}
          </MobileSettingsRow>
        </SettingsGroup>
      )}
    </MobileSettingsDetail>
  );
}

function MobilePrivacySettings(props: MobileSettingsDetailProps) {
  const { LL } = useI18nContext();
  return (
    <MobileSettingsDetail {...props}>
      {({ snapshot }) => (
        <SettingsGroup aria-label={LL.mobileSettings.privacy()}>
          <MobileSettingsRow
            description={LL.mobileSettings.desktopControlsDescription()}
            title={LL.mobileSettings.desktopControls()}
          >
            <Badge variant="outline">{LL.mobileSettings.notExposed()}</Badge>
          </MobileSettingsRow>
          <MobileSettingsRow
            description={LL.mobileSettings.vpnPermissionDescription()}
            title={LL.mobileSettings.vpnPermission()}
          >
            {snapshot.permission === "granted"
              ? LL.mobileSettings.permissionGranted()
              : LL.mobileSettings.permissionRequired()}
          </MobileSettingsRow>
        </SettingsGroup>
      )}
    </MobileSettingsDetail>
  );
}

function MobileUpdatesSettings(props: MobileSettingsDetailProps) {
  const { LL } = useI18nContext();
  return (
    <MobileSettingsDetail {...props}>
      {({ settings }) => (
        <SettingsGroup aria-label={LL.mobileSettings.updates()}>
          <MobileSettingsRow
            description={LL.mobileSettings.updatesAvailabilityDescription()}
            title={LL.mobileSettings.updatesAvailability()}
          >
            <Badge variant={availabilityVariant(settings.snapshot.capabilities.updates)}>
              {availabilityLabel(LL, settings.snapshot.capabilities.updates)}
            </Badge>
          </MobileSettingsRow>
        </SettingsGroup>
      )}
    </MobileSettingsDetail>
  );
}

function MobileDiagnosticsSettings(props: MobileSettingsDetailProps) {
  const { LL } = useI18nContext();
  return (
    <MobileSettingsDetail {...props}>
      {({ snapshot }) => (
        <SettingsGroup aria-label={LL.mobileSettings.diagnostics()}>
          <MobileSettingsRow
            description={LL.mobileSettings.coreDescription()}
            title={LL.mobileSettings.core()}
          >
            {snapshot.coreAvailability === "available" && snapshot.coreVersion
              ? LL.mobileHome.coreVersion({ version: snapshot.coreVersion })
              : LL.mobileSettings.noVerifiedCore()}
          </MobileSettingsRow>
          <MobileSettingsRow
            description={LL.mobileSettings.configurationDescription()}
            title={LL.mobileSettings.configuration()}
          >
            {configurationLabel(LL, snapshot)}
          </MobileSettingsRow>
          <MobileSettingsRow
            description={LL.mobileSettings.failureDescription()}
            title={LL.mobileSettings.failure()}
          >
            {snapshot.failure ? LL.mobileSettings.failurePresent() : LL.mobileSettings.none()}
          </MobileSettingsRow>
        </SettingsGroup>
      )}
    </MobileSettingsDetail>
  );
}

function MobileRecoverySettings(props: MobileSettingsDetailProps) {
  const { LL } = useI18nContext();
  const styles = mobileSettingsStyles();
  return (
    <MobileSettingsDetail {...props}>
      {({ snapshot }) => (
        <>
          <SettingsGroup aria-label={LL.mobileSettings.recovery()}>
            <MobileSettingsRow
              description={LL.mobileSettings.recoveryStateDescription()}
              title={LL.mobileSettings.currentState()}
            >
              <Badge variant={phaseVariant(snapshot.phase)}>{phaseLabel(LL, snapshot.phase)}</Badge>
            </MobileSettingsRow>
            <MobileSettingsRow
              description={LL.mobileSettings.recoveryActionDescription()}
              title={LL.mobileSettings.recoveryAction()}
            >
              {snapshot.phase === "recovery-required"
                ? LL.mobileFixture.reconcileAction()
                : LL.mobileSettings.notRequired()}
            </MobileSettingsRow>
          </SettingsGroup>
          <Link className={styles.action()} to="/status">
            {LL.mobileSettings.manageOnHome()}
          </Link>
        </>
      )}
    </MobileSettingsDetail>
  );
}
