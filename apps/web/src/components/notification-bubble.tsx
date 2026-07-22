import { Bell } from "@phosphor-icons/react/Bell";
import { X } from "@phosphor-icons/react/X";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@mish/ui";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import { cx, tv } from "@mish/ui/tv";
import { systemProxyStatusMessage, tunStatusMessage } from "../data/capture-status-message";
import { useProduct, type LocalProxyTestState } from "../data/product-provider";
import { useCaptureCommand } from "../data/capture-command";
import { useOptionalProfiles } from "../data/profile-provider";
import { useOptionalEvents } from "../data/events-provider";
import { useOptionalSettings } from "../data/settings-provider";
import { trafficFailureMessage } from "../data/traffic-failure-message";
import { tunHelperFailureMessage } from "../data/tun-helper-failure-message";
import { useOptionalTraffic } from "../data/traffic-provider";
import {
  useNotificationDelivery,
  type DeliveredNotification,
  type NotificationActionDescriptor,
} from "../data/notification-delivery";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import { WelcomeDialog } from "./welcome-dialog";

const visibleNotificationLimit = 5;
const welcomePromptToastId = "onboarding-welcome-prompt";
const notificationStyles = tv({
  slots: {
    trigger: cx(
      "toolbar-button notification-trigger relative inline-flex h-8.5 items-center justify-center",
      "gap-1.75 rounded-md border border-transparent bg-transparent px-2.25 text-metadata",
      "text-muted-foreground hover:border-hairline hover:bg-accent hover:text-fg",
      "data-popup-open:border-hairline data-popup-open:bg-accent data-popup-open:text-fg",
    ),
    count: cx(
      "notification-count absolute -top-1 -right-1.25 h-4.25 min-w-4.25 pointer-events-none px-1",
      "text-micro leading-none tabular-nums",
    ),
    popover: "notification-popover w-[min(360px,calc(100vw_-_24px))]",
    header:
      "notification-header flex items-start justify-between gap-3 px-3.5 pt-3.5 pb-3 [&_.ui-button]:flex-none",
    title: "notification-title text-body leading-5 font-semibold",
    description: "notification-description mt-0.5 text-metadata leading-4.5 text-muted-foreground",
    list: cx(
      "notification-list m-0 max-h-[min(360px,calc(100vh_-_180px))] list-none overflow-auto",
      "border-y border-hairline p-0",
    ),
    item: cx(
      "notification-item relative flex min-w-0 flex-col gap-1.25 px-3.5 pt-2.75 pb-3 [&+&]:border-t",
      "[&+&]:border-hairline-soft",
    ),
    itemHeading: cx(
      "notification-item-heading flex items-center justify-between gap-2 pr-6.5 [&_.ui-badge]:h-5",
      "[&_time]:text-caption [&_time]:text-muted-foreground",
    ),
    entryTitle: "notification-entry-title text-metadata font-medium text-ink",
    message:
      "notification-message cursor-text wrap-anywhere text-metadata leading-4.75 font-medium text-fg select-text",
    detail:
      "notification-detail mt-0.75 wrap-anywhere text-metadata leading-4.5 text-muted-foreground",
    remove: cx(
      "notification-remove absolute top-1.75 right-2 size-6.5 opacity-0 pointer-events-none",
      "transition-opacity duration-120 ease-out group-hover/item:opacity-100",
      "group-hover/item:pointer-events-auto group-focus-within/item:opacity-100",
      "group-focus-within/item:pointer-events-auto",
    ),
    actions: "notification-actions flex flex-wrap gap-1.5 pt-0.75",
    empty: "notification-empty min-h-42 rounded-none border-x-0 border-y border-hairline",
    footer: "notification-footer flex px-3.5 pt-2.5 pb-3",
    viewAll: "notification-view-all w-full",
  },
});
type LocalProxyFeedback =
  | { id: string; level: "success"; message: string }
  | { id: string; level: "warning" | "error"; message: string };

function localProxyFeedback(
  LL: TranslationFunctions,
  state: LocalProxyTestState,
): LocalProxyFeedback | null {
  if (state.phase === "failure") {
    return {
      id: "rpc-failure",
      level: "error",
      message: LL.settingsPage.localProxy.feedback.rpcFailure(),
    };
  }
  if (state.phase !== "success") return null;
  switch (state.result.phase) {
    case "ready":
      return {
        id: "ready",
        level: "success",
        message: LL.settingsPage.localProxy.feedback.ready(),
      };
    case "core-unhealthy":
      return {
        id: "core-unhealthy",
        level: "warning",
        message: LL.settingsPage.localProxy.feedback.coreUnhealthy(),
      };
    case "runtime-transition":
      return {
        id: "runtime-transition",
        level: "warning",
        message: LL.settingsPage.localProxy.feedback.runtimeTransition(),
      };
    case "listener-unavailable":
      return {
        id: "listener-unavailable",
        level: "error",
        message: LL.settingsPage.localProxy.feedback.listenerUnavailable(),
      };
    default:
      return null;
  }
}

interface NotificationPublicationControllerProps {
  notificationTriggerRef: RefObject<HTMLButtonElement | null>;
}

/** Publishes domain notifications; the center itself only renders the delivery store. */
function NotificationPublicationController({
  notificationTriggerRef,
}: NotificationPublicationControllerProps) {
  const eventsContext = useOptionalEvents();
  const settingsContext = useOptionalSettings();
  const trafficContext = useOptionalTraffic();
  const {
    commandStates,
    error: productError,
    localProxyTest,
    recoverSystemProxy,
    snapshot,
  } = useProduct();
  const profiles = useOptionalProfiles();
  const { setCapture } = useCaptureCommand();
  const { LL } = useI18nContext();
  const { dismiss, ingestExternalEvents, publish, record, retire, setSession } =
    useNotificationDelivery();
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const welcomePromptStarted = useRef(false);
  const sessionId = eventsContext?.snapshot?.sessionId ?? null;
  const usesAuthoritativeNotifications =
    eventsContext?.snapshot?.adapterKind === "rpc" ||
    (snapshot?.adapterKind === "rpc" && eventsContext !== null && eventsContext.snapshot === null);
  const systemProxy = snapshot?.runtime.systemProxy;
  const managedListenerConflict =
    profiles?.snapshot?.activation.failure === "managed-listener-conflict"
      ? profiles.snapshot.activation.failureEndpoint
      : null;
  const tun = snapshot?.runtime.tun;
  const systemProxyDrift = systemProxy?.phase === "drift";
  const systemProxyFailed = systemProxy?.phase === "failed";
  const tunWarning = tun?.phase === "drift" || tun?.phase === "failed";
  const captureFailureEvent =
    commandStates.capture.phase === "failure"
      ? [...(eventsContext?.events ?? [])]
          .reverse()
          .find((event) => event.notificationKind === "capture-failure")
      : undefined;
  const latestNotificationIds = new Map<string, string>();
  for (const event of [...(eventsContext?.events ?? [])].reverse()) {
    if (event.notificationKind && !latestNotificationIds.has(event.notificationKind)) {
      latestNotificationIds.set(event.notificationKind, event.id);
    }
  }
  // A managed-listener conflict is the authoritative explanation for the same
  // capture attempt even when the status command reports its generic failure
  // before the profile activation snapshot reaches the UI.
  const captureFailureAlreadyExplained =
    (usesAuthoritativeNotifications && commandStates.capture.phase === "failure") ||
    Boolean(captureFailureEvent) ||
    Boolean(managedListenerConflict) ||
    (commandStates.capture.phase === "failure" && (systemProxyFailed || tunWarning));
  const productFailure = Boolean(snapshot && productError && !captureFailureAlreadyExplained);
  const settingsFailure = Boolean(settingsContext?.error);
  const settingsFailureMessage = settingsContext?.tunHelperFailure
    ? tunHelperFailureMessage(LL, settingsContext.tunHelperFailure)
    : LL.settingsPage.updateFailed();
  const trafficFailure = trafficContext?.commandFailure ?? null;
  const localProxyResult = localProxyFeedback(LL, localProxyTest);
  const localProxyFailure =
    localProxyResult && localProxyResult.level !== "success" ? localProxyResult : null;
  const driftObservedAt = useObservedAt(systemProxyDrift);
  const systemProxyFailureObservedAt = useObservedAt(systemProxyFailed);
  const tunWarningObservedAt = useObservedAt(tunWarning);
  const productFailureObservedAt = useObservedAt(productFailure);
  const settingsFailureObservedAt = useObservedAt(settingsFailure);
  const trafficFailureObservedAt = useObservedAt(Boolean(trafficFailure));
  const localProxyFailureObservedAt = useObservedAt(Boolean(localProxyFailure));
  const managedListenerConflictObservedAt = useObservedAt(Boolean(managedListenerConflict));
  const welcomeInvitation = settingsContext?.snapshot.preferences.onboarding.welcomeInvitation;
  const welcomeAvailable = Boolean(welcomeInvitation && welcomeInvitation.completedAt === null);
  const openWelcomeDialog = useCallback(async () => {
    if (!settingsContext) return;
    const opened = await settingsContext.setOnboardingWelcomeState("open");
    if (!opened) return;
    dismiss(welcomePromptToastId);
    setWelcomeOpen(true);
  }, [dismiss, settingsContext]);
  const repairRequiresCore =
    Boolean(systemProxy?.recoveryActions.includes("repair")) &&
    snapshot?.runtime.phase !== "healthy";
  const canRepairSystemProxy =
    (systemProxy?.recoveryActions.includes("repair") ?? false) && !repairRequiresCore;
  const canLeaveSystemProxy = systemProxy?.recoveryActions.includes("leave-as-is") ?? false;
  const systemProxyDriftMessage = repairRequiresCore
    ? LL.capture.systemProxyRepairRequiresCore()
    : systemProxy
      ? systemProxyStatusMessage(LL, systemProxy)
      : "";
  const driftActions: NotificationActionDescriptor[] = [];
  const managedListenerActions: NotificationActionDescriptor[] = [];
  if (managedListenerConflict && settingsContext && snapshot) {
    managedListenerActions.push({
      id: "find-ports-and-retry",
      label: LL.settingsPage.managedPortsFindAndRetry(),
      run: async () => {
        if (!(await settingsContext.findManagedPorts())) return;
        const selection =
          snapshot.runtime.captureSelection.systemProxy || snapshot.runtime.captureSelection.tun
            ? snapshot.runtime.captureSelection
            : { systemProxy: true, tun: false };
        await setCapture(selection, true);
      },
    });
  }
  if (canRepairSystemProxy) {
    driftActions.push({
      id: "repair",
      label: LL.capture.repairSystemProxy(),
      run: () => recoverSystemProxy("repair"),
    });
  }
  if (canLeaveSystemProxy) {
    driftActions.push({
      id: "leave-as-is",
      label: LL.capture.leaveAsIs(),
      tone: "secondary",
      run: () => recoverSystemProxy("leave-as-is"),
    });
  }
  const managedListenerToastVisible = useRef(false);
  useEffect(() => setSession(sessionId), [sessionId, setSession]);
  useEffect(() => {
    if (!eventsContext?.snapshot) return;
    const events = eventsContext.events.filter(
      (event) => !(captureFailureAlreadyExplained && event.message === LL.errors.command()),
    );
    ingestExternalEvents(
      events,
      events
        .filter((event) => event.notificationKind !== null && event.notificationKind !== undefined)
        .map((event) => {
          let message = event.message;
          const isCurrent = latestNotificationIds.get(event.notificationKind ?? "") === event.id;
          if (isCurrent && event.notificationKind === "capture-failure") {
            if (systemProxyDrift) message = systemProxyDriftMessage;
            else if (systemProxyFailed && systemProxy) {
              message = systemProxyStatusMessage(LL, systemProxy);
            } else if (tunWarning && tun) {
              message = tunStatusMessage(LL, tun);
            }
          } else if (
            isCurrent &&
            event.notificationKind === "profile-activation-failure" &&
            managedListenerConflict
          ) {
            message = LL.settingsPage.managedPortsConflict({ endpoint: managedListenerConflict });
          } else if (
            isCurrent &&
            event.notificationKind === "settings-failure" &&
            settingsFailure
          ) {
            message = settingsFailureMessage;
          } else if (isCurrent && event.notificationKind === "traffic-failure" && trafficFailure) {
            message = trafficFailureMessage(LL, trafficFailure);
          }
          return {
            actions:
              isCurrent && event.notificationKind === "capture-failure" && systemProxyDrift
                ? driftActions
                : isCurrent &&
                    event.notificationKind === "profile-activation-failure" &&
                    managedListenerConflict
                  ? managedListenerActions
                  : [],
            detail: event.detail ?? undefined,
            duration:
              isCurrent && event.notificationKind === "capture-failure" && systemProxyDrift
                ? Number.POSITIVE_INFINITY
                : undefined,
            id: event.id,
            level: event.level,
            message,
            observedAt: event.observedAt,
          };
        }),
    );
  }, [
    LL,
    captureFailureAlreadyExplained,
    driftActions,
    eventsContext?.events,
    eventsContext?.snapshot,
    ingestExternalEvents,
    managedListenerActions,
    managedListenerConflict,
    settingsFailure,
    settingsFailureMessage,
    systemProxy,
    systemProxyDrift,
    systemProxyDriftMessage,
    systemProxyFailed,
    trafficFailure,
    tun,
    tunWarning,
  ]);
  useEffect(() => {
    if (!welcomeAvailable || !welcomeInvitation) {
      retire(welcomePromptToastId);
      return;
    }
    record({
      actions: [
        { id: "open-welcome", label: LL.onboarding.notificationAction(), run: openWelcomeDialog },
      ],
      id: welcomePromptToastId,
      level: "info",
      message: LL.onboarding.notificationMessage(),
      observedAt: welcomeInvitation.createdAt,
      title: LL.onboarding.promptTitle(),
    });
  }, [LL, openWelcomeDialog, record, retire, welcomeAvailable, welcomeInvitation]);
  useEffect(() => {
    if (usesAuthoritativeNotifications || !managedListenerConflict) {
      managedListenerToastVisible.current = false;
      retire("managed-listener-conflict");
      return;
    }
    if (managedListenerToastVisible.current) return;
    managedListenerToastVisible.current = true;
    publish({
      actions: managedListenerActions,
      id: "managed-listener-conflict",
      level: "error",
      message: LL.settingsPage.managedPortsConflict({ endpoint: managedListenerConflict }),
      observedAt: managedListenerConflictObservedAt,
      replaces: ["status-operation-failure"],
    });
  }, [
    LL,
    managedListenerActions,
    managedListenerConflict,
    managedListenerConflictObservedAt,
    publish,
    retire,
    usesAuthoritativeNotifications,
  ]);
  const driftToastVisible = useRef(false);
  const systemProxyFailureToastVisible = useRef(false);
  const tunWarningToastVisible = useRef(false);
  const productFailureToastVisible = useRef(false);
  const settingsFailureToastVisible = useRef(false);
  const trafficFailureToastVisible = useRef(false);
  const localProxyToastVisible = useRef(false);

  useEffect(() => {
    if (
      !settingsContext ||
      !welcomeInvitation ||
      welcomeInvitation.completedAt !== null ||
      welcomeInvitation.promptedAt !== null ||
      welcomePromptStarted.current
    ) {
      return;
    }
    welcomePromptStarted.current = true;
    const promptOperation = settingsContext.setOnboardingWelcomeState("prompt");
    publish({
      actions: [
        {
          id: "open-welcome",
          label: LL.onboarding.notificationAction(),
          run: () =>
            promptOperation.then((prompted) => {
              if (prompted) return openWelcomeDialog();
            }),
        },
      ],
      duration: Number.POSITIVE_INFINITY,
      id: welcomePromptToastId,
      level: "info",
      message: LL.onboarding.notificationMessage(),
      observedAt: welcomeInvitation.createdAt,
      title: LL.onboarding.promptTitle(),
    });
    void promptOperation.then((prompted) => {
      if (!prompted) welcomePromptStarted.current = false;
    });
  }, [LL, openWelcomeDialog, publish, settingsContext, welcomeInvitation]);

  useEffect(() => {
    if (!localProxyResult) {
      localProxyToastVisible.current = false;
      retire("local-proxy-ready");
      retire("local-proxy-core-unhealthy");
      retire("local-proxy-runtime-transition");
      retire("local-proxy-listener-unavailable");
      retire("local-proxy-rpc-failure");
      return;
    }
    if (localProxyToastVisible.current) return;
    localProxyToastVisible.current = true;
    publish({
      id: `local-proxy-${localProxyResult.id}`,
      level: localProxyResult.level,
      message: localProxyResult.message,
      observedAt: localProxyFailureObservedAt,
    });
  }, [localProxyFailureObservedAt, localProxyResult, publish, retire]);

  useEffect(() => {
    if (usesAuthoritativeNotifications || !systemProxyDrift) {
      driftToastVisible.current = false;
      retire("system-proxy-drift");
      return;
    }
    if (driftToastVisible.current) return;
    driftToastVisible.current = true;
    publish({
      actions: driftActions,
      duration: Number.POSITIVE_INFINITY,
      id: "system-proxy-drift",
      level: "warning",
      message: systemProxyDriftMessage,
      observedAt: driftObservedAt,
    });
  }, [
    driftActions,
    driftObservedAt,
    publish,
    retire,
    systemProxyDrift,
    systemProxyDriftMessage,
    usesAuthoritativeNotifications,
  ]);

  useEffect(() => {
    if (usesAuthoritativeNotifications || !systemProxyFailed || !systemProxy) {
      systemProxyFailureToastVisible.current = false;
      retire("system-proxy-failure");
      return;
    }
    if (systemProxyFailureToastVisible.current) return;
    systemProxyFailureToastVisible.current = true;
    publish({
      id: "system-proxy-failure",
      level: "error",
      message: systemProxyStatusMessage(LL, systemProxy),
      observedAt: systemProxyFailureObservedAt,
    });
  }, [
    LL,
    publish,
    retire,
    systemProxy,
    systemProxyFailed,
    systemProxyFailureObservedAt,
    usesAuthoritativeNotifications,
  ]);

  useEffect(() => {
    if (usesAuthoritativeNotifications || !tunWarning || !tun) {
      tunWarningToastVisible.current = false;
      retire("tun-drift");
      retire("tun-failed");
      return;
    }
    if (tunWarningToastVisible.current) return;
    tunWarningToastVisible.current = true;
    publish({
      id: `tun-${tun.phase}`,
      level: tun.phase === "failed" ? "error" : "warning",
      message: tunStatusMessage(LL, tun),
      observedAt: tunWarningObservedAt,
    });
  }, [LL, publish, retire, tun, tunWarning, tunWarningObservedAt, usesAuthoritativeNotifications]);

  useEffect(() => {
    if (!productFailure || !productError) {
      productFailureToastVisible.current = false;
      return;
    }
    if (productFailureToastVisible.current) return;
    productFailureToastVisible.current = true;
    publish({
      id: "status-operation-failure",
      level: "error",
      message: productError,
      observedAt: productFailureObservedAt,
    });
  }, [productError, productFailure, productFailureObservedAt, publish]);

  useEffect(() => {
    if (usesAuthoritativeNotifications || !settingsFailure) {
      settingsFailureToastVisible.current = false;
      return;
    }
    if (settingsFailureToastVisible.current) return;
    settingsFailureToastVisible.current = true;
    publish({
      id: "settings-operation-failure",
      level: "error",
      message: settingsFailureMessage,
      observedAt: settingsFailureObservedAt,
    });
  }, [
    publish,
    settingsFailure,
    settingsFailureMessage,
    settingsFailureObservedAt,
    usesAuthoritativeNotifications,
  ]);

  useEffect(() => {
    if (usesAuthoritativeNotifications || !trafficFailure) {
      trafficFailureToastVisible.current = false;
      return;
    }
    if (trafficFailureToastVisible.current) return;
    trafficFailureToastVisible.current = true;
    publish({
      id: "traffic-operation-failure",
      level: "error",
      message: trafficFailureMessage(LL, trafficFailure),
      observedAt: trafficFailureObservedAt,
    });
  }, [LL, publish, trafficFailure, trafficFailureObservedAt, usesAuthoritativeNotifications]);

  return settingsContext ? (
    <WelcomeDialog
      onOpenChange={setWelcomeOpen}
      open={welcomeOpen}
      returnFocusRef={notificationTriggerRef}
    />
  ) : null;
}

export function NotificationBubble() {
  const notificationTriggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <NotificationPublicationController notificationTriggerRef={notificationTriggerRef} />
      <NotificationCenter notificationTriggerRef={notificationTriggerRef} />
    </>
  );
}

function NotificationCenter({ notificationTriggerRef }: NotificationPublicationControllerProps) {
  const { isCommandPending } = useProduct();
  const settingsContext = useOptionalSettings();
  const { LL, locale } = useI18nContext();
  const { entries, execute, markRead, readIds, remove } = useNotificationDelivery();
  const [open, setOpen] = useState(false);
  const retainedNotifications = entries.toSorted(
    (left, right) => right.observedAt - left.observedAt,
  );
  const unreadCount = retainedNotifications.filter(
    (notification) => !readIds.has(notification.id),
  ).length;
  const visibleNotifications = retainedNotifications.slice(0, visibleNotificationLimit);

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) markRead(retainedNotifications.map(({ id }) => id));
    setOpen(nextOpen);
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={LL.notifications.trigger({ count: unreadCount })}
            className={notificationStyles().trigger()}
            ref={notificationTriggerRef}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <Bell aria-hidden="true" />
        {unreadCount > 0 ? (
          <Badge className={notificationStyles().count()} variant="destructive">
            {formatUnreadCount(unreadCount)}
          </Badge>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className={notificationStyles().popover()} sideOffset={8}>
        <div className={notificationStyles().header()}>
          <div>
            <PopoverTitle className={notificationStyles().title()}>
              {LL.notifications.title()}
            </PopoverTitle>
            <PopoverDescription className={notificationStyles().description()}>
              {LL.notifications.description()}
            </PopoverDescription>
          </div>
        </div>
        {visibleNotifications.length > 0 ? (
          <ol className={notificationStyles().list()}>
            {visibleNotifications.map((notification) => (
              <NotificationItem
                disabled={isCommandPending("capture") || Boolean(settingsContext?.pending)}
                key={notification.id}
                LL={LL}
                locale={locale}
                notification={notification}
                onExecute={execute}
                onRemove={remove}
              />
            ))}
          </ol>
        ) : (
          <Empty className={notificationStyles().empty()}>
            <EmptyHeader>
              <EmptyTitle>{LL.notifications.emptyTitle()}</EmptyTitle>
              <EmptyDescription>{LL.notifications.emptyDescription()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <div className={notificationStyles().footer()}>
          <Button
            className={notificationStyles().viewAll()}
            nativeButton={false}
            render={<Link onClick={() => setOpen(false)} to="/events" />}
            size="sm"
            variant="outline"
          >
            {LL.notifications.viewAllEvents()}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface NotificationItemProps {
  disabled: boolean;
  LL: TranslationFunctions;
  locale: Locales;
  notification: DeliveredNotification;
  onExecute(notificationId: string, actionId: string): Promise<void>;
  onRemove(notificationId: string): void;
}

function NotificationItem({
  disabled,
  LL,
  locale,
  notification,
  onExecute,
  onRemove,
}: NotificationItemProps) {
  return (
    <li className={notificationStyles().item({ className: "group/item" })}>
      <Button
        aria-label={LL.notifications.remove({ message: notification.message })}
        className={notificationStyles().remove()}
        onClick={() => onRemove(notification.id)}
        size="icon-sm"
        variant="ghost"
      >
        <X aria-hidden="true" />
      </Button>
      <div className={notificationStyles().itemHeading()}>
        <Badge variant={levelBadge(notification.level)}>
          {LL.events.level[notification.level === "success" ? "info" : notification.level]()}
        </Badge>
        <time className="tabular-nums" dateTime={new Date(notification.observedAt).toISOString()}>
          {formatNotificationTime(notification.observedAt, locale)}
        </time>
      </div>
      {notification.title ? (
        <p className={notificationStyles().entryTitle()}>{notification.title}</p>
      ) : null}
      <p className={notificationStyles().message()} data-native-text-interaction>
        {notification.message}
      </p>
      {notification.detail ? (
        <p className={notificationStyles().detail()}>{notification.detail}</p>
      ) : null}
      {notification.actions.length > 0 ? (
        <div className={notificationStyles().actions()}>
          {notification.actions.map((action) => (
            <Button
              disabled={disabled || Boolean(notification.pendingActionId)}
              key={action.id}
              loading={notification.pendingActionId === action.id}
              loadingText={action.label}
              onClick={() => void onExecute(notification.id, action.id)}
              size="sm"
              variant="outline"
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function levelBadge(level: DeliveredNotification["level"]) {
  if (level === "error") return "destructive" as const;
  if (level === "warning") return "warning" as const;
  return "outline" as const;
}

function formatNotificationTime(value: number, locale: Locales) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatUnreadCount(count: number) {
  return count > 99 ? "99+" : count;
}

function useObservedAt(active: boolean) {
  const [observedAt, setObservedAt] = useState(Date.now);
  const wasActive = useRef(active);

  useEffect(() => {
    if (active && !wasActive.current) setObservedAt(Date.now());
    wasActive.current = active;
  }, [active]);

  return observedAt;
}
