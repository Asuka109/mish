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
import type { EventLevel, EventRecordDto } from "@mish/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { systemProxyStatusMessage, tunStatusMessage } from "../data/capture-status-message";
import { useProduct, type LocalProxyTestState } from "../data/product-provider";
import { useCaptureCommand } from "../data/capture-command";
import { useOptionalProfiles } from "../data/profile-provider";
import { useOptionalEvents } from "../data/events-provider";
import { useOptionalSettings } from "../data/settings-provider";
import { trafficFailureMessage } from "../data/traffic-failure-message";
import { tunHelperFailureMessage } from "../data/tun-helper-failure-message";
import { useOptionalTraffic } from "../data/traffic-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import { WelcomeDialog } from "./welcome-dialog";

const visibleNotificationLimit = 5;
const welcomePromptToastId = "onboarding-welcome-prompt";
const noEvents: EventRecordDto[] = [];

interface NotificationState {
  readNotificationIds: Set<string>;
  removedNotificationIds: Set<string>;
  sessionId: string | null;
}

interface NotificationAction {
  label: string;
  onClick(): Promise<unknown> | void;
}

interface NotificationEntry {
  actions?: NotificationAction[];
  detail?: string;
  id: string;
  level: EventLevel;
  message: string;
  observedAt: number;
}

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

export function NotificationBubble() {
  const eventsContext = useOptionalEvents();
  const settingsContext = useOptionalSettings();
  const trafficContext = useOptionalTraffic();
  const {
    commandStates,
    error: productError,
    isCommandPending,
    localProxyTest,
    recoverSystemProxy,
    snapshot,
  } = useProduct();
  const profiles = useOptionalProfiles();
  const { setCapture } = useCaptureCommand();
  const { LL, locale } = useI18nContext();
  const [open, setOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const notificationTriggerRef = useRef<HTMLButtonElement>(null);
  const welcomePromptStarted = useRef(false);
  const [notificationState, setNotificationState] = useState<NotificationState>({
    readNotificationIds: new Set(),
    removedNotificationIds: new Set(),
    sessionId: null,
  });
  const events = eventsContext?.events ?? noEvents;
  const sessionId = eventsContext?.snapshot?.sessionId ?? null;
  const importantEvents = useMemo(
    () =>
      events
        .filter((event) => event.level === "warning" || event.level === "error")
        .toSorted((left, right) => right.sequence - left.sequence),
    [events],
  );
  const systemProxy = snapshot?.runtime.systemProxy;
  const managedListenerConflict =
    profiles?.snapshot?.activation.failure === "managed-listener-conflict"
      ? profiles.snapshot.activation.failureEndpoint
      : null;
  const tun = snapshot?.runtime.tun;
  const systemProxyDrift = systemProxy?.phase === "drift";
  const systemProxyFailed = systemProxy?.phase === "failed";
  const tunWarning = tun?.phase === "drift" || tun?.phase === "failed";
  const captureFailureAlreadyExplained =
    commandStates.capture.phase === "failure" && (systemProxyFailed || tunWarning);
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
    toast.dismiss(welcomePromptToastId);
    setOpen(false);
    setWelcomeOpen(true);
  }, [settingsContext]);
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
  const driftActions: NotificationAction[] = [];
  const managedListenerActions: NotificationAction[] = [];
  if (managedListenerConflict && settingsContext && snapshot) {
    managedListenerActions.push({
      label: LL.settingsPage.managedPortsFindAndRetry(),
      onClick: async () => {
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
      label: LL.capture.repairSystemProxy(),
      onClick: () => recoverSystemProxy("repair"),
    });
  }
  if (canLeaveSystemProxy) {
    driftActions.push({
      label: LL.capture.leaveAsIs(),
      onClick: () => recoverSystemProxy("leave-as-is"),
    });
  }
  const notifications: NotificationEntry[] = [
    ...(welcomeAvailable && welcomeInvitation && settingsContext
      ? [
          {
            actions: [
              {
                label: LL.onboarding.notificationAction(),
                onClick: openWelcomeDialog,
              },
            ],
            id: `onboarding-welcome:${welcomeInvitation.version}`,
            level: "info" as const,
            message: LL.onboarding.notificationMessage(),
            observedAt: welcomeInvitation.createdAt,
          },
        ]
      : []),
    ...(systemProxyDrift
      ? [
          {
            actions: driftActions,
            id: `system-proxy-drift:${driftObservedAt}`,
            level: "warning" as const,
            message: systemProxyDriftMessage,
            observedAt: driftObservedAt,
          },
        ]
      : []),
    ...(managedListenerConflict
      ? [
          {
            actions: managedListenerActions,
            id: `managed-listener-conflict:${managedListenerConflict}`,
            level: "error" as const,
            message: LL.settingsPage.managedPortsConflict({ endpoint: managedListenerConflict }),
            observedAt: managedListenerConflictObservedAt,
          },
        ]
      : []),
    ...(systemProxyFailed && systemProxy
      ? [
          {
            id: `system-proxy-failure:${systemProxyFailureObservedAt}`,
            level: "error" as const,
            message: systemProxyStatusMessage(LL, systemProxy),
            observedAt: systemProxyFailureObservedAt,
          },
        ]
      : []),
    ...(tunWarning && tun
      ? [
          {
            id: `tun-${tun.phase}:${tunWarningObservedAt}`,
            level: tun.phase === "failed" ? ("error" as const) : ("warning" as const),
            message: tunStatusMessage(LL, tun),
            observedAt: tunWarningObservedAt,
          },
        ]
      : []),
    ...(productFailure && productError
      ? [
          {
            id: `status-operation-failure:${productFailureObservedAt}`,
            level: "error" as const,
            message: productError,
            observedAt: productFailureObservedAt,
          },
        ]
      : []),
    ...(settingsFailure
      ? [
          {
            id: `settings-operation-failure:${settingsFailureObservedAt}`,
            level: "error" as const,
            message: settingsFailureMessage,
            observedAt: settingsFailureObservedAt,
          },
        ]
      : []),
    ...(trafficFailure
      ? [
          {
            id: `traffic-operation-failure:${trafficFailureObservedAt}`,
            level: "error" as const,
            message: trafficFailureMessage(LL, trafficFailure),
            observedAt: trafficFailureObservedAt,
          },
        ]
      : []),
    ...(localProxyFailure
      ? [
          {
            id: `local-proxy-${localProxyFailure.id}:${localProxyFailureObservedAt}`,
            level: localProxyFailure.level,
            message: localProxyFailure.message,
            observedAt: localProxyFailureObservedAt,
          },
        ]
      : []),
    ...importantEvents.map((event) => ({
      detail: event.detail ?? undefined,
      id: event.id,
      level: event.level as "error" | "warning",
      message: event.message,
      observedAt: event.observedAt,
    })),
  ];
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
    toast.info(LL.onboarding.promptTitle(), {
      action: {
        label: LL.onboarding.notificationAction(),
        onClick: () => {
          void promptOperation.then((prompted) => {
            if (prompted) return openWelcomeDialog();
          });
        },
      },
      description: LL.onboarding.notificationMessage(),
      duration: Number.POSITIVE_INFINITY,
      id: welcomePromptToastId,
    });
    void promptOperation.then((prompted) => {
      if (!prompted) welcomePromptStarted.current = false;
    });
  }, [LL, openWelcomeDialog, settingsContext, welcomeInvitation]);

  useEffect(() => {
    if (!localProxyResult) {
      localProxyToastVisible.current = false;
      return;
    }
    if (localProxyToastVisible.current) return;
    localProxyToastVisible.current = true;
    if (localProxyResult.level === "success") toast.success(localProxyResult.message);
    else if (localProxyResult.level === "warning") toast.warning(localProxyResult.message);
    else toast.error(localProxyResult.message);
  }, [localProxyResult]);

  useEffect(() => {
    if (!systemProxyDrift) {
      driftToastVisible.current = false;
      toast.dismiss("system-proxy-drift");
      return;
    }
    if (driftToastVisible.current) return;
    driftToastVisible.current = true;
    toast.warning(systemProxyDriftMessage, {
      action: canRepairSystemProxy
        ? {
            label: LL.capture.repairSystemProxy(),
            onClick: () => void recoverSystemProxy("repair"),
          }
        : undefined,
      cancel: canLeaveSystemProxy
        ? {
            label: LL.capture.leaveAsIs(),
            onClick: () => void recoverSystemProxy("leave-as-is"),
          }
        : undefined,
      duration: Number.POSITIVE_INFINITY,
      id: "system-proxy-drift",
    });
  }, [
    LL,
    canLeaveSystemProxy,
    canRepairSystemProxy,
    recoverSystemProxy,
    systemProxyDriftMessage,
    systemProxyDrift,
  ]);

  useEffect(() => {
    if (!systemProxyFailed || !systemProxy) {
      systemProxyFailureToastVisible.current = false;
      return;
    }
    if (systemProxyFailureToastVisible.current) return;
    systemProxyFailureToastVisible.current = true;
    toast.error(systemProxyStatusMessage(LL, systemProxy));
  }, [LL, systemProxy, systemProxyFailed]);

  useEffect(() => {
    if (!tunWarning || !tun) {
      tunWarningToastVisible.current = false;
      return;
    }
    if (tunWarningToastVisible.current) return;
    tunWarningToastVisible.current = true;
    const message = tunStatusMessage(LL, tun);
    if (tun.phase === "failed") toast.error(message);
    else toast.warning(message);
  }, [LL, tun, tunWarning]);

  useEffect(() => {
    if (!productFailure || !productError) {
      productFailureToastVisible.current = false;
      return;
    }
    if (productFailureToastVisible.current) return;
    productFailureToastVisible.current = true;
    toast.error(productError);
  }, [productError, productFailure]);

  useEffect(() => {
    if (!settingsFailure) {
      settingsFailureToastVisible.current = false;
      return;
    }
    if (settingsFailureToastVisible.current) return;
    settingsFailureToastVisible.current = true;
    toast.error(settingsFailureMessage);
  }, [settingsFailure, settingsFailureMessage]);

  useEffect(() => {
    if (!trafficFailure) {
      trafficFailureToastVisible.current = false;
      return;
    }
    if (trafficFailureToastVisible.current) return;
    trafficFailureToastVisible.current = true;
    toast.error(trafficFailureMessage(LL, trafficFailure));
  }, [LL, trafficFailure]);

  const notificationsByTime = notifications.toSorted(
    (left, right) => right.observedAt - left.observedAt,
  );
  const readNotificationIds =
    notificationState.sessionId === sessionId
      ? notificationState.readNotificationIds
      : new Set<string>();
  const removedNotificationIds =
    notificationState.sessionId === sessionId
      ? notificationState.removedNotificationIds
      : new Set<string>();
  const retainedNotifications = notificationsByTime.filter(
    (notification) => !removedNotificationIds.has(notification.id),
  );
  const unreadCount = retainedNotifications.filter(
    (notification) => !readNotificationIds.has(notification.id),
  ).length;
  const visibleNotifications = retainedNotifications.slice(0, visibleNotificationLimit);

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setNotificationState((current) => ({
        readNotificationIds: new Set(retainedNotifications.map(({ id }) => id)),
        removedNotificationIds:
          current.sessionId === sessionId ? current.removedNotificationIds : new Set(),
        sessionId,
      }));
    }
    setOpen(nextOpen);
  }

  function removeNotification(notificationId: string) {
    setNotificationState((current) => {
      const sameSession = current.sessionId === sessionId;
      return {
        readNotificationIds: sameSession ? current.readNotificationIds : new Set(),
        removedNotificationIds: new Set([
          ...(sameSession ? current.removedNotificationIds : []),
          notificationId,
        ]),
        sessionId,
      };
    });
  }

  return (
    <>
      <Popover onOpenChange={handleOpenChange} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label={LL.notifications.trigger({ count: unreadCount })}
              className="toolbar-button notification-trigger"
              ref={notificationTriggerRef}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <Bell aria-hidden="true" />
          {unreadCount > 0 ? (
            <Badge className="notification-count tabular" variant="destructive">
              {formatUnreadCount(unreadCount)}
            </Badge>
          ) : null}
        </PopoverTrigger>
        <PopoverContent align="end" className="notification-popover" sideOffset={8}>
          <div className="notification-header">
            <div>
              <PopoverTitle className="notification-title">{LL.notifications.title()}</PopoverTitle>
              <PopoverDescription className="notification-description">
                {LL.notifications.description()}
              </PopoverDescription>
            </div>
          </div>

          {visibleNotifications.length > 0 ? (
            <ol className="notification-list">
              {visibleNotifications.map((notification) => (
                <NotificationItem
                  disabled={isCommandPending("capture") || Boolean(settingsContext?.pending)}
                  key={notification.id}
                  LL={LL}
                  locale={locale}
                  notification={notification}
                  onRemove={removeNotification}
                />
              ))}
            </ol>
          ) : (
            <Empty className="notification-empty">
              <EmptyHeader>
                <EmptyTitle>{LL.notifications.emptyTitle()}</EmptyTitle>
                <EmptyDescription>{LL.notifications.emptyDescription()}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          <div className="notification-footer">
            <Button
              className="notification-view-all"
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
      {settingsContext ? (
        <WelcomeDialog
          onOpenChange={setWelcomeOpen}
          open={welcomeOpen}
          returnFocusRef={notificationTriggerRef}
        />
      ) : null}
    </>
  );
}

interface NotificationItemProps {
  disabled: boolean;
  LL: TranslationFunctions;
  locale: Locales;
  notification: NotificationEntry;
  onRemove(notificationId: string): void;
}

function NotificationItem({ disabled, LL, locale, notification, onRemove }: NotificationItemProps) {
  const [pendingAction, setPendingAction] = useState<{
    label: string;
    promise: Promise<unknown>;
  } | null>(null);

  function runAction(action: NotificationAction) {
    const promise = Promise.resolve().then(() => action.onClick());
    setPendingAction({ label: action.label, promise });
  }

  return (
    <li className="notification-item">
      <Button
        aria-label={LL.notifications.remove({ message: notification.message })}
        className="notification-remove"
        onClick={() => onRemove(notification.id)}
        size="icon-sm"
        variant="ghost"
      >
        <X aria-hidden="true" />
      </Button>
      <div className="notification-item-heading">
        <Badge variant={levelBadge(notification.level)}>
          {LL.events.level[notification.level]()}
        </Badge>
        <time className="tabular" dateTime={new Date(notification.observedAt).toISOString()}>
          {formatNotificationTime(notification.observedAt, locale)}
        </time>
      </div>
      <p className="notification-message" data-native-text-interaction>
        {notification.message}
      </p>
      {notification.detail ? <p className="notification-detail">{notification.detail}</p> : null}
      {notification.actions && notification.actions.length > 0 ? (
        <div className="notification-actions">
          {notification.actions.map((action) => (
            <Button
              disabled={disabled}
              key={action.label}
              loading={pendingAction?.label === action.label ? pendingAction.promise : false}
              loadingText={action.label}
              onClick={() => runAction(action)}
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

function levelBadge(level: EventLevel) {
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
