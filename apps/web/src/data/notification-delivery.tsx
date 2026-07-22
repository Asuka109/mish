import type { EventLevel, EventRecordDto } from "@mish/contracts";
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
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

interface NotificationDeliveryContextValue {
  entries: readonly DeliveredNotification[];
  publish(envelope: NotificationEnvelope): void;
  record(envelope: NotificationEnvelope): void;
  dismiss(id: string): void;
  execute(id: string, actionId: string): Promise<void>;
  markRead(ids: readonly string[]): void;
  readIds: ReadonlySet<string>;
  remove(id: string): void;
  ingestExternalEvents(events: readonly EventRecordDto[]): void;
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
  const [sessionId, setSessionId] = useState<string | null>(null);

  const dismiss = useCallback((id: string) => dismissNotificationToast(id), []);

  const execute = useCallback(async (id: string, actionId?: string) => {
    let action: NotificationActionDescriptor | undefined;
    setEntries((current) => {
      const entry = current.find((item) => item.id === id);
      action = entry?.actions.find((item) => item.id === actionId) ?? entry?.actions[0];
      if (!entry || !action || entry.pendingActionId) return current;
      return current.map((item) =>
        item.id === id ? { ...item, pendingActionId: action?.id } : item,
      );
    });
    if (!action) return;
    try {
      await action.run();
      if (action.dismissToastOnSuccess) dismissNotificationToast(id);
    } catch {
      // Application actions deliberately expose only their own localized, safe failures.
    } finally {
      setEntries((current) =>
        current.map((entry) =>
          entry.id === id ? { ...entry, pendingActionId: undefined } : entry,
        ),
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
        presentNotificationToast(entry, (actionId) => void execute(entry.id, actionId));
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

  const ingestExternalEvents = useCallback((events: readonly EventRecordDto[]) => {
    const history = events
      .filter((event) => event.level === "warning" || event.level === "error")
      .map<DeliveredNotification>((event) => ({
        actions: [],
        detail: bounded(event.detail ?? undefined),
        id: event.id,
        level: event.level,
        message: bounded(event.message) ?? "",
        observedAt: event.observedAt,
        source: "event",
      }));
    setEntries((current) => {
      const applications = current.filter((entry) => entry.source === "application");
      const next = [...applications, ...history].toSorted(
        (left, right) => right.observedAt - left.observedAt,
      );
      if (
        current.length === next.length &&
        current.every((entry, index) => {
          const candidate = next[index];
          return (
            candidate && entry.id === candidate.id && entry.observedAt === candidate.observedAt
          );
        })
      ) {
        return current;
      }
      return next;
    });
  }, []);

  const setSession = useCallback((nextSessionId: string | null) => {
    setSessionId((currentSessionId) => {
      if (currentSessionId === nextSessionId) return currentSessionId;
      if (currentSessionId !== null) {
        setEntries([]);
        setReadIds(new Set());
        setRemovedIds(new Set());
      }
      return nextSessionId;
    });
  }, []);

  const value = useMemo<NotificationDeliveryContextValue>(
    () => ({
      dismiss,
      entries: entries.filter(({ id }) => !removedIds.has(id)),
      execute: (id, actionId) => execute(id, actionId),
      markRead,
      ingestExternalEvents,
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
      ingestExternalEvents,
      markRead,
      publish,
      readIds,
      record,
      removedIds,
      remove,
      retire,
      setSession,
      sessionId,
    ],
  );
  return <NotificationDeliveryContext value={value}>{children}</NotificationDeliveryContext>;
}

export function useNotificationDelivery() {
  const value = use(NotificationDeliveryContext);
  if (!value) throw new Error("NotificationDeliveryProvider is required");
  return value;
}
