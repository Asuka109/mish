import type {
  MobileFixtureBootstrapDto,
  MobileVpnPhase,
  MobileVpnSnapshotDto,
} from "@mish/contracts";
import { Button, SectionGrid, SectionGridItem, Spinner } from "@mish/ui";
import { Gauge } from "@phosphor-icons/react/Gauge";
import { Power } from "@phosphor-icons/react/Power";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx, tv } from "@mish/ui/tv";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";

const mobileHomeStyles = tv({
  slots: {
    page: cx(
      "mobile-home-page h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain",
      "px-4 pt-3 pb-[max(24px,env(safe-area-inset-bottom))]",
    ),
    content: "mx-auto grid w-full max-w-130 min-w-0 gap-3.5",
    authority: cx(
      "mobile-home-authority grid min-w-0 gap-4 rounded-lg border bg-canvas p-4",
      "shadow-panel",
    ),
    authorityHeader: "flex min-w-0 items-start gap-3",
    authorityIcon: cx(
      "grid size-12 shrink-0 place-items-center rounded-full border [&_svg]:size-6",
    ),
    authorityCopy: "grid min-w-0 flex-1 gap-1",
    eyebrow: "text-caption leading-4 font-medium text-muted-foreground",
    state: "text-title leading-7 font-semibold tracking-tight text-ink",
    description: "max-w-110 text-body leading-5 text-fg",
    action: cx(
      "mobile-home-primary-action h-12 w-full rounded-compact border-brand bg-brand px-4",
      "text-body font-medium text-brand-foreground active:brightness-95",
      "disabled:border-hairline disabled:bg-surface-soft disabled:text-muted-foreground",
    ),
    commandFailure: cx(
      "rounded-md border border-feedback-error-border bg-badge-error-background px-3 py-2.5",
      "text-metadata leading-4.5 text-error",
    ),
    section: "grid min-w-0 gap-2",
    sectionHeading: "px-1 text-body font-semibold text-ink",
    factRow: cx(
      "grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(0,max-content)] items-center gap-3",
      "px-3.5 py-2.5",
    ),
    factCopy: "grid min-w-0 gap-0.5",
    factLabel: "font-medium text-fg",
    factDescription: "text-metadata leading-4.5 text-muted-foreground",
    factValue: "max-w-38 text-end text-metadata font-medium text-muted-foreground",
    fixtureNotice: cx(
      "mobile-home-fixture-notice grid gap-1 rounded-md border border-feedback-warning-border",
      "bg-mobile-fixture-background px-3 py-2.5 text-metadata leading-4.5",
    ),
    fixtureLabel: "font-medium text-warning",
  },
  variants: {
    tone: {
      neutral: {
        authority: "border-hairline",
        authorityIcon: "border-hairline bg-surface-soft text-muted-foreground",
      },
      pending: {
        authority: "border-feedback-warning-border",
        authorityIcon: "border-feedback-warning-border bg-badge-warning-background text-warning",
      },
      success: {
        authority: "border-badge-success-border",
        authorityIcon: "border-badge-success-border bg-badge-success-background text-success-text",
      },
      warning: {
        authority: "border-feedback-warning-border",
        authorityIcon: "border-feedback-warning-border bg-badge-warning-background text-warning",
      },
      error: {
        authority: "border-feedback-error-border",
        authorityIcon: "border-feedback-error-border bg-badge-error-background text-error",
      },
    },
  },
  defaultVariants: { tone: "neutral" },
});

type HomeTone = "error" | "neutral" | "pending" | "success" | "warning";

interface MobileHomePageProps {
  fixture: MobileFixtureBootstrapDto;
  initialSnapshot: MobileVpnSnapshotDto;
  vpnClient: MobileVpnClient;
}

interface MobileHomeProjection {
  action: "notification" | "permission" | "start" | "stop";
  actionLabel: string;
  busy: boolean;
  description: string;
  icon: ReactNode;
  state: string;
  tone: HomeTone;
}

function phaseCopy(LL: TranslationFunctions, phase: MobileVpnPhase) {
  switch (phase) {
    case "permission-required":
      return {
        description: LL.mobileHome.permissionRequiredDescription(),
        state: LL.mobileHome.permissionRequiredState(),
        tone: "warning" as const,
      };
    case "starting":
      return {
        description: LL.mobileHome.startingDescription(),
        state: LL.mobileHome.startingState(),
        tone: "pending" as const,
      };
    case "running":
      return {
        description: LL.mobileHome.runningDescription(),
        state: LL.mobileHome.runningState(),
        tone: "success" as const,
      };
    case "stopping":
      return {
        description: LL.mobileHome.stoppingDescription(),
        state: LL.mobileHome.stoppingState(),
        tone: "pending" as const,
      };
    case "failed":
      return {
        description: LL.mobileHome.failedDescription(),
        state: LL.mobileHome.failedState(),
        tone: "error" as const,
      };
    case "recovery-required":
      return {
        description: LL.mobileHome.recoveryDescription(),
        state: LL.mobileHome.recoveryState(),
        tone: "error" as const,
      };
    case "unavailable":
      return {
        description: LL.mobileHome.unavailableDescription(),
        state: LL.mobileHome.unavailableState(),
        tone: "warning" as const,
      };
    case "stopped":
      return {
        description: LL.mobileHome.stoppedDescription(),
        state: LL.mobileHome.stoppedState(),
        tone: "neutral" as const,
      };
  }
}

export function projectMobileHome(
  LL: TranslationFunctions,
  snapshot: MobileVpnSnapshotDto,
): MobileHomeProjection {
  const phase = phaseCopy(LL, snapshot.phase);
  const busy = snapshot.phase === "starting" || snapshot.phase === "stopping";
  const icon = busy ? (
    <Spinner />
  ) : snapshot.phase === "running" ? (
    <ShieldCheck aria-hidden="true" weight="fill" />
  ) : snapshot.phase === "failed" || snapshot.phase === "recovery-required" ? (
    <WarningCircle aria-hidden="true" weight="fill" />
  ) : snapshot.phase === "unavailable" || snapshot.phase === "permission-required" ? (
    <Gauge aria-hidden="true" />
  ) : (
    <Power aria-hidden="true" />
  );

  if (snapshot.foreground || snapshot.phase === "recovery-required") {
    return {
      ...phase,
      action: "stop",
      actionLabel:
        snapshot.phase === "recovery-required"
          ? LL.mobileFixture.reconcileAction()
          : LL.mobileFixture.stopAction(),
      busy,
      icon,
    };
  }
  if (snapshot.permission !== "granted") {
    return {
      ...phase,
      action: "permission",
      actionLabel: LL.mobileFixture.permissionAction(),
      busy,
      icon,
    };
  }
  if (snapshot.notificationPermission === "required") {
    return {
      ...phase,
      action: "notification",
      actionLabel: LL.mobileFixture.notificationAction(),
      busy,
      icon,
    };
  }
  return {
    ...phase,
    action: "start",
    actionLabel:
      snapshot.phase === "failed"
        ? LL.mobileHome.retryAction()
        : LL.mobileFixture.lifecycleAction(),
    busy,
    icon,
  };
}

function coreEvidence(LL: TranslationFunctions, snapshot: MobileVpnSnapshotDto) {
  if (snapshot.coreAvailability !== "available" || !snapshot.coreVersion) {
    return {
      description: LL.mobileHome.coreUnavailableDescription(),
      value: LL.mobileHome.unavailableValue(),
    };
  }
  return {
    description: LL.mobileHome.corePackagedDescription(),
    value: LL.mobileHome.coreVersion({ version: snapshot.coreVersion }),
  };
}

export function MobileHomePage({ fixture, initialSnapshot, vpnClient }: MobileHomePageProps) {
  const { LL } = useI18nContext();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [commandFailed, setCommandFailed] = useState(false);
  const commandInFlight = useRef(false);
  const projection = projectMobileHome(LL, snapshot);
  const core = coreEvidence(LL, snapshot);

  useEffect(
    () =>
      vpnClient.subscribe((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setCommandFailed(false);
      }),
    [vpnClient],
  );

  async function runLifecycleAction() {
    if (commandInFlight.current || projection.busy) return;
    commandInFlight.current = true;
    setCommandFailed(false);
    try {
      if (projection.action === "stop") {
        await vpnClient.stop();
      } else if (projection.action === "permission") {
        await vpnClient.requestVpnConsent();
      } else if (projection.action === "notification") {
        await vpnClient.requestNotificationPermission();
      } else {
        await vpnClient.startFixtureLifecycle();
      }
    } catch {
      setCommandFailed(true);
    } finally {
      commandInFlight.current = false;
    }
  }

  const styles = mobileHomeStyles({ tone: projection.tone });

  return (
    <div className={styles.page()}>
      <div className={styles.content()}>
        <section
          aria-labelledby="mobile-home-vpn-state"
          className={styles.authority()}
          data-phase={snapshot.phase}
        >
          <div aria-live="polite" className={styles.authorityHeader()}>
            <span aria-hidden="true" className={styles.authorityIcon()}>
              {projection.icon}
            </span>
            <div className={styles.authorityCopy()}>
              <p className={styles.eyebrow()}>{LL.mobileHome.authorityLabel()}</p>
              <h2 className={styles.state()} id="mobile-home-vpn-state">
                {projection.state}
              </h2>
              <p className={styles.description()} id="mobile-home-vpn-description">
                {projection.description}
              </p>
            </div>
          </div>
          {fixture.platform === "android" ? (
            <Button
              aria-busy={projection.busy}
              aria-describedby="mobile-home-vpn-description"
              className={styles.action()}
              disabled={projection.busy}
              onClick={() => void runLifecycleAction()}
            >
              {projection.busy ? <Spinner data-icon="inline-start" /> : null}
              {projection.busy ? LL.common.pending() : projection.actionLabel}
            </Button>
          ) : null}
          {commandFailed ? (
            <p className={styles.commandFailure()} role="alert">
              {LL.mobileFixture.commandFailed()}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="mobile-home-current-title" className={styles.section()}>
          <h2 className={styles.sectionHeading()} id="mobile-home-current-title">
            {LL.mobileHome.currentSection()}
          </h2>
          <SectionGrid>
            <SectionGridItem className={styles.factRow()}>
              <div className={styles.factCopy()}>
                <strong className={styles.factLabel()}>{LL.mobileHome.profileLabel()}</strong>
                <span className={styles.factDescription()}>
                  {LL.mobileHome.profileUnavailableDescription()}
                </span>
              </div>
              <span className={styles.factValue()}>{LL.mobileHome.unavailableValue()}</span>
            </SectionGridItem>
            <SectionGridItem className={styles.factRow()}>
              <div className={styles.factCopy()}>
                <strong className={styles.factLabel()}>{LL.mobileHome.routingLabel()}</strong>
                <span className={styles.factDescription()}>
                  {LL.mobileHome.routingUnavailableDescription()}
                </span>
              </div>
              <span className={styles.factValue()}>{LL.mobileHome.unavailableValue()}</span>
            </SectionGridItem>
          </SectionGrid>
        </section>

        <section aria-labelledby="mobile-home-readiness-title" className={styles.section()}>
          <h2 className={styles.sectionHeading()} id="mobile-home-readiness-title">
            {LL.mobileHome.readinessSection()}
          </h2>
          <SectionGrid>
            <SectionGridItem className={styles.factRow()}>
              <div className={styles.factCopy()}>
                <strong className={styles.factLabel()}>{LL.mobileHome.coreLabel()}</strong>
                <span className={styles.factDescription()}>{core.description}</span>
              </div>
              <span className={styles.factValue()}>{core.value}</span>
            </SectionGridItem>
            <SectionGridItem className={styles.factRow()}>
              <div className={styles.factCopy()}>
                <strong className={styles.factLabel()}>{LL.mobileHome.throughputLabel()}</strong>
                <span className={styles.factDescription()}>
                  {LL.mobileHome.throughputUnavailableDescription()}
                </span>
              </div>
              <span className={styles.factValue()}>{LL.mobileHome.unavailableValue()}</span>
            </SectionGridItem>
          </SectionGrid>
        </section>

        <aside className={styles.fixtureNotice()}>
          <strong className={styles.fixtureLabel()}>{LL.mobileHome.fixtureLabel()}</strong>
          <span>{LL.mobileHome.fixtureDescription()}</span>
        </aside>
      </div>
    </div>
  );
}
