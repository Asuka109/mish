import type {
  ApplicationActionId,
  ApplicationNotification,
  ApplicationNotificationDataByKind,
  ApplicationNotificationKind,
  NotificationClient,
  NotificationPublicationDto,
  NotificationRecordDto,
  NotificationSnapshotDelivery,
  NotificationSnapshotDto,
} from "@mish/contracts";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18nContext } from "../i18n/i18n-react";
import { FixtureNotificationClient } from "./fixture-notification-client";
import { presentNotification, type DeliveredNotification } from "./notification-registry";

export type { DeliveredNotification, NotificationActionDescriptor } from "./notification-registry";

export interface NotificationDeliveryContextValue {
  entries: readonly DeliveredNotification[];
  markRead(ids: readonly string[]): void;
  publish(publication: NotificationPublicationDto): void;
  remove(id: string): void;
  retire(dedupeKey: string): void;
  toastEntries: readonly DeliveredNotification[];
}

const NotificationDeliveryContext = createContext<NotificationDeliveryContextValue | null>(null);

export function NotificationDeliveryProvider({
  children,
  client,
}: {
  children: ReactNode;
  client?: NotificationClient;
}) {
  const resolvedClient = useMemo(() => client ?? new FixtureNotificationClient(), [client]);
  const { LL } = useI18nContext();
  const [snapshot, setSnapshot] = useState<NotificationSnapshotDto>({
    notifications: [],
    revision: 0,
  });
  const [toastIds, setToastIds] = useState<ReadonlySet<string>>(new Set());
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    const unsubscribe = resolvedClient.subscribeSnapshots((delivery) => {
      if (delivery.kind === "baseline") {
        snapshotRef.current = delivery.snapshot;
        setSnapshot(delivery.snapshot);
        setToastIds(new Set());
        return;
      }
      applyUpdate(delivery, snapshotRef, setSnapshot, setToastIds);
    });
    return () => {
      unsubscribe();
      if (!client) resolvedClient.dispose();
    };
  }, [client, resolvedClient]);

  const publish = useCallback(
    (publication: NotificationPublicationDto) => {
      void resolvedClient.publish(publication).catch(() => undefined);
    },
    [resolvedClient],
  );
  const markRead = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      void resolvedClient.markRead(ids).catch(() => undefined);
    },
    [resolvedClient],
  );
  const remove = useCallback(
    (id: string) => {
      void resolvedClient.remove(id).catch(() => undefined);
    },
    [resolvedClient],
  );
  const retire = useCallback(
    (dedupeKey: string) => {
      void resolvedClient.removeByDedupeKey(dedupeKey).catch(() => undefined);
    },
    [resolvedClient],
  );

  const entries = useMemo(
    () => snapshot.notifications.map((record) => presentNotification(record, LL)),
    [LL, snapshot.notifications],
  );
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const toastEntries = useMemo(
    () => [...toastIds].flatMap((id) => entryById.get(id) ?? []),
    [entryById, toastIds],
  );
  const value = useMemo<NotificationDeliveryContextValue>(
    () => ({ entries, markRead, publish, remove, retire, toastEntries }),
    [entries, markRead, publish, remove, retire, toastEntries],
  );
  return <NotificationDeliveryContext value={value}>{children}</NotificationDeliveryContext>;
}

export function useNotificationDelivery() {
  const value = use(NotificationDeliveryContext);
  if (!value) throw new Error("NotificationDeliveryProvider is required");
  return value;
}

function applyUpdate(
  delivery: NotificationSnapshotDelivery,
  snapshotRef: { current: NotificationSnapshotDto },
  setSnapshot: (snapshot: NotificationSnapshotDto) => void,
  setToastIds: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
) {
  const previous = snapshotRef.current;
  if (delivery.snapshot.revision <= previous.revision) return;
  const previousIds = new Set(previous.notifications.map(({ id }) => id));
  const nextById = new Map(delivery.snapshot.notifications.map((record) => [record.id, record]));
  setToastIds((current) => {
    const next = new Set(current);
    for (const id of current) {
      const record = nextById.get(id);
      if (!record || record.resolved) next.delete(id);
    }
    for (const record of delivery.snapshot.notifications) {
      if (!previousIds.has(record.id) && !record.resolved) next.add(record.id);
    }
    return next;
  });
  snapshotRef.current = delivery.snapshot;
  setSnapshot(delivery.snapshot);
}

export function notificationPublication<K extends ApplicationNotificationKind>(
  kind: K,
  options: {
    actionIds?: readonly ApplicationActionId[];
    dedupeKey?: string;
    pinned?: boolean;
    replaces?: string[];
    resolved?: boolean;
    severity: NotificationPublicationDto["severity"];
  } & (ApplicationNotificationDataByKind[K] extends Record<string, never>
    ? { data?: ApplicationNotificationDataByKind[K] }
    : { data: ApplicationNotificationDataByKind[K] }),
): NotificationPublicationDto {
  return {
    dedupeKey: options.dedupeKey ?? `${kind}:${crypto.randomUUID()}`,
    pinned: options.pinned ?? false,
    presentation: {
      actionIds: [...(options.actionIds ?? [])],
      data: options.data ?? {},
      kind,
    } as ApplicationNotification,
    replaces: options.replaces ?? [],
    resolved: options.resolved ?? false,
    severity: options.severity,
  };
}

export function notificationRecord(
  record: Partial<NotificationRecordDto> & Pick<NotificationRecordDto, "id" | "presentation">,
): NotificationRecordDto {
  return {
    createdRevision: 1,
    dedupeKey: record.id,
    observedAt: Date.now(),
    pinned: false,
    read: false,
    resolved: false,
    revision: 1,
    severity: "info",
    ...record,
  };
}
