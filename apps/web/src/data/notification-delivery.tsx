import type { EventLevel } from "@mish/contracts";
import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { presentNotificationToast, dismissNotificationToast } from "./sonner-notification-adapter";

const maxActions = 2;
const maxTextLength = 500;

export type NotificationActionTone = "primary" | "secondary" | "destructive";
export type NotificationActionDisposition = "keep" | "dismiss-toast";

export interface NotificationActionDescriptor {
  id: string;
  label: string;
  tone?: NotificationActionTone;
  dismissToastOnSuccess?: boolean;
  run(): Promise<unknown> | unknown;
}

export type NotificationLevel = EventLevel | "success";

export interface NotificationEnvelope {
  id: string;
  level: NotificationLevel;
  title?: string;
  message: string;
  detail?: string;
  observedAt?: number;
  duration?: number;
  actions?: readonly NotificationActionDescriptor[];
  /** Controls toast presentation while retaining the same entry in Notifications. */
  toast?: "present" | "dismiss";
  /**
   * Canonical IDs made obsolete by this more specific publication. This is
   * session-local and removes only the retained/toast projections, never
   * external event history.
   */
  replaces?: readonly string[];
}

export interface DeliveredNotification extends Omit<
  Required<Pick<NotificationEnvelope, "id" | "level" | "message">>,
  "id"
> {
  id: string;
  title?: string;
  detail?: string;
  observedAt: number;
  duration?: number;
  actions: readonly NotificationActionDescriptor[];
  pendingActionId?: string;
  source: "application" | "event";
}

export interface NotificationDeliveryContextValue {
  entries: readonly DeliveredNotification[];
  publish(envelope: NotificationEnvelope): void;
  record(envelope: NotificationEnvelope): void;
  dismiss(id: string): void;
  execute(id: string, actionId: string): Promise<void>;
  markRead(ids: readonly string[]): void;
  readIds: ReadonlySet<string>;
  remove(id: string): void;
  reconcileExternalNotifications(notifications: readonly NotificationEnvelope[]): void;
  retire(id: string): void;
  setSession(sessionId: string | null): void;
}

const NotificationDeliveryContext = createContext<NotificationDeliveryContextValue | null>(null);

function bounded(value: string | undefined) {
  if (!value) return undefined;
  return value.slice(0, maxTextLength);
}

function normalize(envelope: NotificationEnvelope): DeliveredNotification {
  return {
    actions: (envelope.actions ?? []).slice(0, maxActions),
    detail: bounded(envelope.detail),
    duration: envelope.duration,
    id: envelope.id,
    level: envelope.level,
    message: envelope.message.slice(0, maxTextLength),
    observedAt: envelope.observedAt ?? Date.now(),
    source: "application",
    title: bounded(envelope.title),
  };
}

export function NotificationDeliveryProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<readonly DeliveredNotification[]>([]);
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set());
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const sessionId = useRef<string | null>(null);
  const externalNotificationsInitialized = useRef(false);
  const seenExternalNotificationIds = useRef<ReadonlySet<string>>(new Set());
  const presentedExternalNotifications = useRef<ReadonlyMap<string, string>>(new Map());

  const dismiss = useCallback((id: string) => dismissNotificationToast(id), []);

  const execute = useCallback(async (id: string, actionId?: string) => {
    let action: NotificationActionDescriptor | undefined;
    let dismissedToast = false;
    setEntries((current) => {
      const entry = current.find((item) => item.id === id);
      const candidate = entry?.actions.find((item) => item.id === actionId) ?? entry?.actions[0];
      if (!entry || !candidate || entry.pendingActionId) return current;
      action = candidate;
      const pendingEntry = { ...entry, pendingActionId: candidate.id };
      presentNotificationToast(pendingEntry, (nextActionId) => execute(id, nextActionId));
      return current.map((item) => (item.id === id ? pendingEntry : item));
    });
    if (!action) return;
    try {
      await action.run();
      if (action.dismissToastOnSuccess) {
        dismissedToast = true;
        dismissNotificationToast(id);
      }
    } catch {
      // Application actions deliberately expose only their own localized, safe failures.
    } finally {
      setEntries((current) =>
        current.map((entry) => {
          if (entry.id !== id) return entry;
          const settledEntry = { ...entry, pendingActionId: undefined };
          if (!dismissedToast) {
            presentNotificationToast(settledEntry, (nextActionId) => execute(id, nextActionId));
          }
          return settledEntry;
        }),
      );
    }
  }, []);

  const publish = useCallback(
    (envelope: NotificationEnvelope) => {
      const entry = normalize(envelope);
      setEntries((current) => {
        const replacedIds = new Set(envelope.replaces ?? []);
        const next = [
          ...current.filter(({ id }) => id !== entry.id && !replacedIds.has(id)),
          entry,
        ].toSorted((left, right) => right.observedAt - left.observedAt);
        for (const replacedId of replacedIds) dismissNotificationToast(replacedId);
        if (envelope.toast === "dismiss") dismissNotificationToast(entry.id);
        else presentNotificationToast(entry, (actionId) => execute(entry.id, actionId));
        return next;
      });
    },
    [execute],
  );

  const record = useCallback((envelope: NotificationEnvelope) => {
    const entry = normalize(envelope);
    setEntries((current) => {
      const existing = current.find(({ id }) => id === entry.id);
      if (
        existing &&
        existing.message === entry.message &&
        existing.title === entry.title &&
        existing.observedAt === entry.observedAt &&
        existing.actions.length === entry.actions.length
      ) {
        return current;
      }
      return [...current.filter(({ id }) => id !== entry.id), entry].toSorted(
        (left, right) => right.observedAt - left.observedAt,
      );
    });
  }, []);

  const markRead = useCallback((ids: readonly string[]) => {
    setReadIds((current) => new Set([...current, ...ids]));
  }, []);

  const remove = useCallback((id: string) => {
    setRemovedIds((current) => new Set([...current, id]));
  }, []);

  const retire = useCallback((id: string) => {
    setEntries((current) => {
      if (!current.some((entry) => entry.id === id)) return current;
      return current.filter((entry) => entry.id !== id);
    });
    dismissNotificationToast(id);
  }, []);

  const reconcileExternalNotifications = useCallback(
    (notifications: readonly NotificationEnvelope[]) => {
      const replacementObservedAt = new Map<string, number>();
      for (const notification of notifications) {
        for (const replacedId of notification.replaces ?? []) {
          replacementObservedAt.set(
            replacedId,
            Math.max(replacementObservedAt.get(replacedId) ?? 0, notification.observedAt ?? 0),
          );
        }
      }
      const history = notifications.map<DeliveredNotification>((notification) => ({
        ...normalize(notification),
        source: "event",
      }));
      if (externalNotificationsInitialized.current) {
        const presented = new Map(presentedExternalNotifications.current);
        for (const [index, entry] of history.entries()) {
          const notification = notifications[index]!;
          const presentation = JSON.stringify({
            actions: entry.actions.map(({ id }) => id),
            detail: entry.detail,
            level: entry.level,
            message: entry.message,
            title: entry.title,
            toast: notification.toast,
          });
          const previousPresentation = presented.get(entry.id);
          if (notification.toast === "dismiss") {
            dismissNotificationToast(entry.id);
            presented.set(entry.id, presentation);
          } else if (
            !seenExternalNotificationIds.current.has(entry.id) ||
            (previousPresentation !== undefined && previousPresentation !== presentation)
          ) {
            presentNotificationToast(entry, (actionId) => execute(entry.id, actionId));
            presented.set(entry.id, presentation);
          }
        }
        presentedExternalNotifications.current = presented;
      }
      seenExternalNotificationIds.current = new Set(notifications.map(({ id }) => id));
      externalNotificationsInitialized.current = true;
      setEntries((current) => {
        const applications = current.filter((entry) => {
          if (entry.source !== "application") return false;
          const replacement = replacementObservedAt.get(entry.id);
          if (replacement === undefined || entry.observedAt > replacement) return true;
          dismissNotificationToast(entry.id);
          return false;
        });
        const next = [...applications, ...history].toSorted(
          (left, right) => right.observedAt - left.observedAt,
        );
        if (
          current.length === next.length &&
          current.every((entry, index) => {
            const candidate = next[index];
            return (
              candidate &&
              entry.id === candidate.id &&
              entry.observedAt === candidate.observedAt &&
              entry.message === candidate.message &&
              entry.detail === candidate.detail &&
              entry.title === candidate.title &&
              entry.actions.length === candidate.actions.length &&
              entry.actions.every(
                (action, actionIndex) => action.id === candidate.actions[actionIndex]?.id,
              )
            );
          })
        ) {
          return current;
        }
        return next;
      });
    },
    [],
  );

  const setSession = useCallback((nextSessionId: string | null) => {
    if (sessionId.current === nextSessionId) return;
    if (sessionId.current !== null) {
      setEntries([]);
      setReadIds(new Set());
      setRemovedIds(new Set());
    }
    externalNotificationsInitialized.current = false;
    seenExternalNotificationIds.current = new Set();
    presentedExternalNotifications.current = new Map();
    sessionId.current = nextSessionId;
  }, []);

  const value = useMemo<NotificationDeliveryContextValue>(
    () => ({
      dismiss,
      entries: entries.filter(({ id }) => !removedIds.has(id)),
      execute: (id, actionId) => execute(id, actionId),
      markRead,
      reconcileExternalNotifications,
      publish,
      record,
      readIds,
      remove,
      retire,
      setSession,
    }),
    [
      dismiss,
      entries,
      execute,
      markRead,
      publish,
      readIds,
      reconcileExternalNotifications,
      record,
      removedIds,
      remove,
      retire,
      setSession,
    ],
  );
  return <NotificationDeliveryContext value={value}>{children}</NotificationDeliveryContext>;
}

export function useNotificationDelivery() {
  const value = use(NotificationDeliveryContext);
  if (!value) throw new Error("NotificationDeliveryProvider is required");
  return value;
}
