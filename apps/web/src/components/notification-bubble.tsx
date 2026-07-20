import { Bell } from "@phosphor-icons/react/Bell";
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
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { systemProxyStatusMessage, tunStatusMessage } from "../data/capture-status-message";
import { useProduct } from "../data/product-provider";
import { useOptionalEvents } from "../data/events-provider";
import { useOptionalSettings } from "../data/settings-provider";
import { trafficFailureMessage } from "../data/traffic-failure-message";
import { useOptionalTraffic } from "../data/traffic-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";

const visibleNotificationLimit = 5;
const noEvents: EventRecordDto[] = [];

interface ReadNotificationState {
  notificationIds: Set<string>;
  sessionId: string | null;
}

interface NotificationAction {
  label: string;
  onClick(): void;
}

interface NotificationEntry {
  actions?: NotificationAction[];
  id: string;
  level: "error" | "warning";
  message: string;
  observedAt: number;
  source: string;
}

export function NotificationBubble() {
  const eventsContext = useOptionalEvents();
  const settingsContext = useOptionalSettings();
  const trafficContext = useOptionalTraffic();
  const { error: productError, isCommandPending, recoverSystemProxy, snapshot } = useProduct();
  const { LL, locale } = useI18nContext();
  const [open, setOpen] = useState(false);
  const [readState, setReadState] = useState<ReadNotificationState>({
    notificationIds: new Set(),
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
  const tun = snapshot?.runtime.tun;
  const systemProxyDrift = systemProxy?.phase === "drift";
  const systemProxyFailed = systemProxy?.phase === "failed";
  const tunWarning = tun?.phase === "drift" || tun?.phase === "failed";
  const productFailure = Boolean(snapshot && productError);
  const settingsFailure = Boolean(settingsContext?.error);
  const trafficFailure = trafficContext?.commandFailure ?? null;
  const driftObservedAt = useObservedAt(systemProxyDrift);
  const systemProxyFailureObservedAt = useObservedAt(systemProxyFailed);
  const tunWarningObservedAt = useObservedAt(tunWarning);
  const productFailureObservedAt = useObservedAt(productFailure);
  const settingsFailureObservedAt = useObservedAt(settingsFailure);
  const trafficFailureObservedAt = useObservedAt(Boolean(trafficFailure));
  const canRepairSystemProxy = systemProxy?.recoveryActions.includes("repair") ?? false;
  const canLeaveSystemProxy = systemProxy?.recoveryActions.includes("leave-as-is") ?? false;
  const driftActions: NotificationAction[] = [];
  if (canRepairSystemProxy) {
    driftActions.push({
      label: LL.capture.repairSystemProxy(),
      onClick: () => void recoverSystemProxy("repair"),
    });
  }
  if (canLeaveSystemProxy) {
    driftActions.push({
      label: LL.capture.leaveAsIs(),
      onClick: () => void recoverSystemProxy("leave-as-is"),
    });
  }
  const notifications: NotificationEntry[] = [
    ...(systemProxyDrift
      ? [
          {
            actions: driftActions,
            id: `system-proxy-drift:${driftObservedAt}`,
            level: "warning" as const,
            message: LL.capture.systemProxyDrift(),
            observedAt: driftObservedAt,
            source: LL.navigation.status(),
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
            source: LL.navigation.status(),
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
            source: LL.navigation.status(),
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
            source: LL.navigation.status(),
          },
        ]
      : []),
    ...(settingsFailure
      ? [
          {
            id: `settings-operation-failure:${settingsFailureObservedAt}`,
            level: "error" as const,
            message: LL.settingsPage.updateFailed(),
            observedAt: settingsFailureObservedAt,
            source: LL.navigation.settings(),
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
            source: LL.navigation.traffic(),
          },
        ]
      : []),
    ...importantEvents.map((event) => ({
      id: event.id,
      level: event.level as "error" | "warning",
      message: event.message,
      observedAt: event.observedAt,
      source: LL.events.source[event.source](),
    })),
  ];
  const driftToastVisible = useRef(false);
  const systemProxyFailureToastVisible = useRef(false);
  const tunWarningToastVisible = useRef(false);
  const productFailureToastVisible = useRef(false);
  const settingsFailureToastVisible = useRef(false);
  const trafficFailureToastVisible = useRef(false);

  useEffect(() => {
    if (!systemProxyDrift) {
      driftToastVisible.current = false;
      toast.dismiss("system-proxy-drift");
      return;
    }
    if (driftToastVisible.current) return;
    driftToastVisible.current = true;
    toast.warning(LL.capture.systemProxyDrift(), {
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
  }, [LL, canLeaveSystemProxy, canRepairSystemProxy, recoverSystemProxy, systemProxyDrift]);

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
    toast.error(LL.settingsPage.updateFailed());
  }, [LL, settingsFailure]);

  useEffect(() => {
    if (!trafficFailure) {
      trafficFailureToastVisible.current = false;
      return;
    }
    if (trafficFailureToastVisible.current) return;
    trafficFailureToastVisible.current = true;
    toast.error(trafficFailureMessage(LL, trafficFailure));
  }, [LL, trafficFailure]);

  const readNotificationIds =
    readState.sessionId === sessionId ? readState.notificationIds : new Set<string>();
  const unreadCount = notifications.filter(
    (notification) => !readNotificationIds.has(notification.id),
  ).length;
  const visibleNotifications = notifications.slice(0, visibleNotificationLimit);

  function markAllRead() {
    setReadState({
      notificationIds: new Set(notifications.map(({ id }) => id)),
      sessionId,
    });
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={LL.notifications.trigger({ count: unreadCount })}
            className="toolbar-button notification-trigger"
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
          <Button disabled={unreadCount === 0} onClick={markAllRead} size="sm" variant="ghost">
            {LL.notifications.markAllRead()}
          </Button>
        </div>

        {visibleNotifications.length > 0 ? (
          <ol className="notification-list">
            {visibleNotifications.map((notification) => (
              <NotificationItem
                disabled={isCommandPending("capture")}
                key={notification.id}
                LL={LL}
                locale={locale}
                notification={notification}
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
  );
}

interface NotificationItemProps {
  disabled: boolean;
  LL: TranslationFunctions;
  locale: Locales;
  notification: NotificationEntry;
}

function NotificationItem({ disabled, LL, locale, notification }: NotificationItemProps) {
  return (
    <li className="notification-item">
      <div className="notification-item-heading">
        <Badge variant={levelBadge(notification.level)}>
          {LL.events.level[notification.level]()}
        </Badge>
        <time className="tabular" dateTime={new Date(notification.observedAt).toISOString()}>
          {formatNotificationTime(notification.observedAt, locale)}
        </time>
      </div>
      <p>{notification.message}</p>
      <span>{notification.source}</span>
      {notification.actions && notification.actions.length > 0 ? (
        <div className="notification-actions">
          {notification.actions.map((action) => (
            <Button
              disabled={disabled}
              key={action.label}
              onClick={action.onClick}
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
