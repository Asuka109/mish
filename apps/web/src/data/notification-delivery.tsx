import type {
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
  readIds: ReadonlySet<string>;
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
  const [toastRevisions, setToastRevisions] = useState<ReadonlyMap<string, number>>(new Map());
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    const unsubscribe = resolvedClient.subscribeSnapshots((delivery) => {
      if (delivery.kind === "baseline") {
        snapshotRef.current = delivery.snapshot;
        setSnapshot(delivery.snapshot);
        setToastRevisions(new Map());
        return;
      }
      applyUpdate(delivery, snapshotRef, setSnapshot, setToastRevisions);
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
    () => [...toastRevisions.keys()].flatMap((id) => entryById.get(id) ?? []),
    [entryById, toastRevisions],
  );
  const readIds = useMemo(
    () => new Set(snapshot.notifications.filter(({ read }) => read).map(({ id }) => id)),
    [snapshot.notifications],
  );
  const value = useMemo<NotificationDeliveryContextValue>(
    () => ({ entries, markRead, publish, readIds, retire, toastEntries }),
    [entries, markRead, publish, readIds, retire, toastEntries],
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
  setToastRevisions: (
    update: (current: ReadonlyMap<string, number>) => ReadonlyMap<string, number>,
  ) => void,
) {
  const previous = snapshotRef.current;
  if (delivery.snapshot.revision <= previous.revision) return;
  const previousIds = new Set(previous.notifications.map(({ id }) => id));
  const nextById = new Map(delivery.snapshot.notifications.map((record) => [record.id, record]));
  setToastRevisions((current) => {
    const next = new Map(current);
    for (const id of current.keys()) {
      const record = nextById.get(id);
      if (!record || record.resolved) next.delete(id);
      else if (record.revision > (current.get(id) ?? -1)) next.set(id, record.revision);
    }
    for (const record of delivery.snapshot.notifications) {
      if (!previousIds.has(record.id) && !record.resolved) next.set(record.id, record.revision);
    }
    return next;
  });
  snapshotRef.current = delivery.snapshot;
  setSnapshot(delivery.snapshot);
}

export function notificationPublication(
  type: NotificationPublicationDto["type"],
  options: Omit<NotificationPublicationDto, "params" | "replaces" | "resolved" | "type"> &
    Partial<Pick<NotificationPublicationDto, "params" | "replaces" | "resolved">>,
): NotificationPublicationDto {
  return {
    params: {},
    replaces: [],
    resolved: false,
    ...options,
    type,
  };
}

export function notificationRecord(
  record: Partial<NotificationRecordDto> & Pick<NotificationRecordDto, "id" | "type">,
): NotificationRecordDto {
  return {
    createdRevision: 1,
    dedupeKey: record.id,
    observedAt: Date.now(),
    params: {},
    read: false,
    resolved: false,
    revision: 1,
    severity: "info",
    ...record,
  };
}
