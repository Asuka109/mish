import type {
  ApplicationActionId,
  ApplicationNotification,
  ApplicationNotificationDataByKind,
  ApplicationNotificationKind,
  NotificationClient,
  NotificationPresentationClaimDto,
  NotificationPresentationFoldReason,
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

export interface ToastDeliveredNotification extends DeliveredNotification {
  presentationAttempt: number;
}

export interface NotificationDeliveryContextValue {
  completePresentation(notificationId: string, outcome: NotificationPresentationFoldReason): void;
  entries: readonly DeliveredNotification[];
  markRead(ids: readonly string[]): void;
  publish(publication: NotificationPublicationDto): void;
  remove(id: string): void;
  retire(dedupeKey: string): void;
  toastEntries: readonly ToastDeliveredNotification[];
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
  const [activeClaim, setActiveClaim] = useState<NotificationPresentationClaimDto | null>(null);
  const [presentationAttempt, setPresentationAttempt] = useState(0);
  const activeClaimRef = useRef(activeClaim);
  const claimRequestInFlight = useRef(false);
  const completingClaims = useRef(new Set<string>());
  const mounted = useRef(false);
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    activeClaimRef.current = activeClaim;
  }, [activeClaim]);

  const requestNextClaim = useCallback(() => {
    if (
      !mounted.current ||
      claimRequestInFlight.current ||
      activeClaimRef.current ||
      !hasUnpresentedNotification(snapshotRef.current)
    ) {
      return;
    }
    claimRequestInFlight.current = true;
    void resolvedClient
      .claimPresentation()
      .catch(() => undefined)
      .finally(() => {
        claimRequestInFlight.current = false;
      });
  }, [resolvedClient]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = resolvedClient.subscribeSnapshots((delivery) => {
      const result = applyDelivery(
        delivery,
        snapshotRef,
        activeClaimRef,
        setSnapshot,
        setActiveClaim,
      );
      if (
        result.revisionAdvanced &&
        !result.claim &&
        hasUnpresentedNotification(delivery.snapshot)
      ) {
        requestNextClaim();
      }
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      activeClaimRef.current = null;
      if (!client) resolvedClient.dispose();
    };
  }, [client, requestNextClaim, resolvedClient]);

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
  const completePresentation = useCallback(
    (notificationId: string, outcome: NotificationPresentationFoldReason) => {
      const claim = activeClaimRef.current;
      if (!claim || claim.id !== notificationId) return;
      const key = `${claim.id}:${claim.leaseGeneration}:${claim.revision}`;
      if (completingClaims.current.has(key)) return;
      completingClaims.current.add(key);
      void resolvedClient
        .completePresentation(claim, outcome)
        .then((result) => {
          if (!mounted.current) return;
          if (!result.accepted) {
            if (sameLease(activeClaimRef.current, claim)) {
              setPresentationAttempt((attempt) => attempt + 1);
            }
            return;
          }
          if (!sameClaim(activeClaimRef.current, claim)) return;
          activeClaimRef.current = null;
          setActiveClaim(null);
        })
        .catch(() => undefined)
        .finally(() => {
          completingClaims.current.delete(key);
          if (mounted.current) requestNextClaim();
        });
    },
    [requestNextClaim, resolvedClient],
  );

  const entries = useMemo(
    () => snapshot.notifications.map((record) => presentNotification(record, LL)),
    [LL, snapshot.notifications],
  );
  const toastEntries = useMemo<readonly ToastDeliveredNotification[]>(() => {
    const record = activeClaim ? presentationRecord(snapshot, activeClaim) : null;
    return record ? [{ ...presentNotification(record, LL), presentationAttempt }] : [];
  }, [LL, activeClaim, presentationAttempt, snapshot]);
  const value = useMemo<NotificationDeliveryContextValue>(
    () => ({ completePresentation, entries, markRead, publish, remove, retire, toastEntries }),
    [completePresentation, entries, markRead, publish, remove, retire, toastEntries],
  );
  return <NotificationDeliveryContext value={value}>{children}</NotificationDeliveryContext>;
}

export function useNotificationDelivery() {
  const value = use(NotificationDeliveryContext);
  if (!value) throw new Error("NotificationDeliveryProvider is required");
  return value;
}

function applyDelivery(
  delivery: NotificationSnapshotDelivery,
  snapshotRef: { current: NotificationSnapshotDto },
  activeClaimRef: { current: NotificationPresentationClaimDto | null },
  setSnapshot: (snapshot: NotificationSnapshotDto) => void,
  setActiveClaim: (claim: NotificationPresentationClaimDto | null) => void,
) {
  const previous = snapshotRef.current;
  if (delivery.kind === "update" && delivery.snapshot.revision < previous.revision) {
    return { claim: activeClaimRef.current, revisionAdvanced: false };
  }
  if (
    delivery.kind === "update" &&
    delivery.snapshot.revision === previous.revision &&
    delivery.claim === undefined
  ) {
    return { claim: activeClaimRef.current, revisionAdvanced: false };
  }

  const revisionAdvanced = delivery.snapshot.revision > previous.revision;
  const nextClaim =
    delivery.kind === "baseline"
      ? normalizeClaim(delivery.snapshot, delivery.claim ?? null)
      : delivery.claim
        ? normalizeClaim(delivery.snapshot, delivery.claim)
        : reconcileClaim(delivery.snapshot, activeClaimRef.current);
  snapshotRef.current = delivery.snapshot;
  activeClaimRef.current = nextClaim;
  setSnapshot(delivery.snapshot);
  setActiveClaim(nextClaim);
  return { claim: nextClaim, revisionAdvanced };
}

function hasUnpresentedNotification(snapshot: NotificationSnapshotDto) {
  return snapshot.notifications.some(
    ({ presentationState }) => presentationState.phase === "unpresented",
  );
}

function normalizeClaim(
  snapshot: NotificationSnapshotDto,
  claim: NotificationPresentationClaimDto | null,
) {
  return claim ? reconcileClaim(snapshot, claim) : null;
}

function presentationRecord(
  snapshot: NotificationSnapshotDto,
  claim: NotificationPresentationClaimDto,
) {
  const record = snapshot.notifications.find(({ id }) => id === claim.id) ?? null;
  if (!record || record.presentationState.phase !== "presenting") return null;
  return record.presentationState.leaseGeneration === claim.leaseGeneration ? record : null;
}

function reconcileClaim(
  snapshot: NotificationSnapshotDto,
  claim: NotificationPresentationClaimDto | null,
) {
  if (!claim) return null;
  const record = presentationRecord(snapshot, claim);
  if (!record || record.presentationState.phase !== "presenting") return null;
  return {
    id: claim.id,
    leaseExpiresAt: record.presentationState.leaseExpiresAt,
    leaseGeneration: claim.leaseGeneration,
    revision: record.revision,
  };
}

function sameClaim(
  left: NotificationPresentationClaimDto | null,
  right: NotificationPresentationClaimDto,
) {
  return (
    left?.id === right.id &&
    left.leaseGeneration === right.leaseGeneration &&
    left.revision === right.revision
  );
}

function sameLease(
  left: NotificationPresentationClaimDto | null,
  right: NotificationPresentationClaimDto,
) {
  return left?.id === right.id && left.leaseGeneration === right.leaseGeneration;
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
    presentationState: { phase: "unpresented" },
    read: false,
    resolved: false,
    revision: 1,
    severity: "info",
    ...record,
  };
}
