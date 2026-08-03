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
import { notificationPublication, useNotificationDelivery } from "../data/notification-delivery";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";

const mobileHomeStyles = tv({
  slots: {
    page: cx(
      "mobile-home-page h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain scroll-pb-8",
      "px-4 pt-4 pb-8",
    ),
    content: "mx-auto grid w-full max-w-130 min-w-0 gap-6",
    authority: cx(
      "mobile-home-authority grid min-w-0 gap-5 rounded-lg border bg-canvas p-5",
      "shadow-panel",
    ),
    authorityHeader: "flex min-w-0 items-start gap-4",
    authorityIcon: cx(
      "grid size-12 shrink-0 place-items-center rounded-full border [&_svg]:size-6",
    ),
    authorityCopy: "grid min-w-0 flex-1 gap-1.5",
    eyebrow: "text-caption leading-4 font-medium text-muted-foreground",
    state: "min-h-14 text-title leading-7 font-semibold tracking-tight text-ink",
    description: "min-h-20 max-w-110 text-body leading-5 text-fg",
    action: cx(
      "mobile-home-primary-action h-12 w-full rounded-compact border-brand bg-brand px-4",
      "text-body font-medium text-brand-foreground active:brightness-95",
      "disabled:border-hairline disabled:bg-surface-soft disabled:text-muted-foreground",
    ),
    configActions: "flex flex-wrap gap-3",
    configAction: cx(
      "h-11 min-w-36 flex-1 rounded-compact border border-hairline bg-canvas px-3",
      "text-metadata font-medium text-fg active:bg-surface-soft",
      "disabled:text-muted-foreground",
    ),
    section: "grid min-w-0 gap-3",
    sectionHeading: "px-1 text-body leading-5 font-semibold text-ink",
    factsGrid:
      "[&>:first-child]:rounded-t-section-grid-inner [&>:last-child]:rounded-b-section-grid-inner",
    factRow: cx(
      "grid min-h-18 grid-cols-[minmax(0,1fr)_minmax(0,max-content)] items-center gap-4 overflow-visible",
      "px-4 py-3",
    ),
    factCopy: "grid min-w-0 gap-0.5",
    factLabel: "font-medium text-fg",
    factDescription: "text-metadata leading-4.5 text-muted-foreground",
    factValue: "max-w-38 text-end text-metadata font-medium text-muted-foreground",
    fixtureNotice: cx(
      "mobile-home-fixture-notice grid gap-1 rounded-md border border-feedback-warning-border",
      "bg-mobile-fixture-background px-4 py-3 text-metadata leading-4.5",
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

const fictionalConfigA = new TextEncoder().encode(
  "mode: rule\nproxies: []\nproxy-groups: []\nrules: []\n",
);
const fictionalConfigB = new TextEncoder().encode(
  "mode: direct\nproxies: []\nproxy-groups: []\nrules: []\n",
);
const fictionalConfigAIdentity = {
  digest: "68f2de0232c31d5790035632a9b745bc2e3dfb926d55cd36c4e0fdfa8d54ddc5",
  revision: "fictional-a-v1",
};
const fictionalConfigBIdentity = {
  digest: "b9692e9a47cdab4379c8125bcd83407a89d5290cbfa4c6218bb58e1d50bae686",
  revision: "fictional-b-v1",
};

const mobileConfigFailureNotificationKey = "mobile-config-load";
const mobileLifecycleFailureNotificationKey = "mobile-vpn-lifecycle";

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

function configEvidence(LL: TranslationFunctions, snapshot: MobileVpnSnapshotDto) {
  if (snapshot.coreConfigState === "loaded" && snapshot.loadedConfigRevision) {
    return {
      description: LL.mobileHome.configLoadedDescription(),
      value: LL.mobileHome.configLoadedValue({ revision: snapshot.loadedConfigRevision }),
    };
  }
  if (snapshot.coreConfigState === "unknown") {
    return {
      description: LL.mobileHome.configUnknownDescription(),
      value: LL.mobileHome.configUnknownValue(),
    };
  }
  if (snapshot.validatedConfigRevision) {
    return {
      description: LL.mobileHome.configValidatedDescription(),
      value: LL.mobileHome.configValidatedValue({
        revision: snapshot.validatedConfigRevision,
      }),
    };
  }
  return {
    description: LL.mobileHome.configUnloadedDescription(),
    value: LL.mobileHome.configUnloadedValue(),
  };
}

function lifecycleFailureNotification() {
  return notificationPublication("status.operation-failed", {
    data: { failure: "mobile-vpn-lifecycle" },
    dedupeKey: mobileLifecycleFailureNotificationKey,
    severity: "error",
  });
}

function configFailureNotification() {
  return notificationPublication("settings.operation-failed", {
    data: { failure: "mobile-config-load" },
    dedupeKey: mobileConfigFailureNotificationKey,
    severity: "error",
  });
}

function hasLifecycleFailure(snapshot: MobileVpnSnapshotDto) {
  return snapshot.phase === "failed" || snapshot.phase === "recovery-required";
}

export function MobileHomePage({ fixture, initialSnapshot, vpnClient }: MobileHomePageProps) {
  const { LL } = useI18nContext();
  const { publish, retire } = useNotificationDelivery();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [loadInFlight, setLoadInFlight] = useState(false);
  const commandInFlight = useRef(false);
  const lifecycleAbortController = useRef<AbortController | undefined>(undefined);
  const loadInFlightRef = useRef(false);
  const projection = projectMobileHome(LL, snapshot);
  const core = coreEvidence(LL, snapshot);
  const config = configEvidence(LL, snapshot);
  const canCancelStart = snapshot.phase === "starting" && snapshot.foreground;

  useEffect(
    () =>
      vpnClient.subscribe((nextSnapshot) => {
        setSnapshot(nextSnapshot);
      }),
    [vpnClient],
  );

  useEffect(() => {
    if (hasLifecycleFailure(snapshot)) {
      publish(lifecycleFailureNotification());
      return;
    }
    retire(mobileLifecycleFailureNotificationKey);
  }, [publish, retire, snapshot.phase]);

  async function runLifecycleAction() {
    if (commandInFlight.current) {
      if (canCancelStart) lifecycleAbortController.current?.abort();
      return;
    }
    if (projection.busy) return;
    commandInFlight.current = true;
    let controller: AbortController | undefined;
    try {
      let nextSnapshot: MobileVpnSnapshotDto;
      if (projection.action === "stop") {
        nextSnapshot = await vpnClient.stop();
      } else if (projection.action === "permission") {
        nextSnapshot = await vpnClient.requestVpnConsent();
      } else if (projection.action === "notification") {
        nextSnapshot = await vpnClient.requestNotificationPermission();
      } else {
        controller = new AbortController();
        lifecycleAbortController.current = controller;
        nextSnapshot = await vpnClient.start({ signal: controller.signal });
      }
      if (hasLifecycleFailure(nextSnapshot)) {
        publish(lifecycleFailureNotification());
      } else {
        retire(mobileLifecycleFailureNotificationKey);
      }
    } catch {
      publish(lifecycleFailureNotification());
    } finally {
      if (lifecycleAbortController.current === controller) {
        lifecycleAbortController.current = undefined;
      }
      commandInFlight.current = false;
    }
  }

  async function runConfigAction(action: "first" | "replace" | "reject") {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setLoadInFlight(true);
    const useSecond =
      action === "replace" ||
      (action === "reject" && snapshot.loadedConfigRevision !== fictionalConfigBIdentity.revision);
    const bytes = useSecond ? fictionalConfigB : fictionalConfigA;
    const identity = useSecond ? fictionalConfigBIdentity : fictionalConfigAIdentity;
    try {
      const result = await vpnClient.loadConfig(bytes, identity, {
        injectFailure: action === "reject",
        timeoutMillis: 10_000,
      });
      if (result.failure) {
        publish(configFailureNotification());
      } else {
        retire(mobileConfigFailureNotificationKey);
      }
    } catch {
      publish(configFailureNotification());
    } finally {
      loadInFlightRef.current = false;
      setLoadInFlight(false);
    }
  }

  const styles = mobileHomeStyles({ tone: projection.tone });

  return (
    <div className={styles.page()}>
      <div className={styles.content()}>
        <section
          aria-labelledby="mobile-home-vpn-state"
          className={styles.authority()}
          data-active-network={snapshot.activeNetwork}
          data-core-running={snapshot.coreRunning}
          data-dns-applied={snapshot.dnsApplied}
          data-foreground={snapshot.foreground}
          data-phase={snapshot.phase}
          data-protected-sockets={snapshot.protectedSocketCount}
          data-public-request={snapshot.publicRequestObserved}
          data-routes-applied={snapshot.routesApplied}
          data-same-session={snapshot.activationSessionId === snapshot.sessionId}
          data-tun-established={snapshot.tunEstablished}
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
              disabled={projection.busy && !canCancelStart}
              onClick={() => void runLifecycleAction()}
            >
              {projection.busy ? <Spinner data-icon="inline-start" /> : null}
              {canCancelStart
                ? LL.mobileFixture.stopAction()
                : projection.busy
                  ? LL.common.pending()
                  : projection.actionLabel}
            </Button>
          ) : null}
        </section>

        <section aria-labelledby="mobile-home-current-title" className={styles.section()}>
          <h2 className={styles.sectionHeading()} id="mobile-home-current-title">
            {LL.mobileHome.currentSection()}
          </h2>
          <SectionGrid className={styles.factsGrid()}>
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
          <SectionGrid className={styles.factsGrid()}>
            <SectionGridItem className={styles.factRow()}>
              <div className={styles.factCopy()}>
                <strong className={styles.factLabel()}>{LL.mobileHome.coreLabel()}</strong>
                <span className={styles.factDescription()}>{core.description}</span>
              </div>
              <span className={styles.factValue()}>{core.value}</span>
            </SectionGridItem>
            <SectionGridItem className={styles.factRow()}>
              <div className={styles.factCopy()}>
                <strong className={styles.factLabel()}>{LL.mobileHome.configLabel()}</strong>
                <span className={styles.factDescription()}>{config.description}</span>
              </div>
              <span className={styles.factValue()}>{config.value}</span>
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
          {snapshot.coreAvailability === "available" ? (
            <div aria-label={LL.mobileHome.configActionsLabel()} className={styles.configActions()}>
              <Button
                className={styles.configAction()}
                disabled={loadInFlight}
                onClick={() => void runConfigAction("first")}
              >
                {LL.mobileHome.loadConfigAction()}
              </Button>
              <Button
                className={styles.configAction()}
                disabled={loadInFlight}
                onClick={() => void runConfigAction("replace")}
              >
                {LL.mobileHome.replaceConfigAction()}
              </Button>
              {snapshot.configFailureInjectionAvailable ? (
                <Button
                  className={styles.configAction()}
                  disabled={loadInFlight || snapshot.coreConfigState !== "loaded"}
                  onClick={() => void runConfigAction("reject")}
                >
                  {LL.mobileHome.rejectReplacementAction()}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>

        <aside className={styles.fixtureNotice()}>
          <strong className={styles.fixtureLabel()}>{LL.mobileHome.fixtureLabel()}</strong>
          <span>{LL.mobileHome.fixtureDescription()}</span>
        </aside>
      </div>
    </div>
  );
}
