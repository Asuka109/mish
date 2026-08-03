import { act, render } from "@testing-library/react";
import type {
  NotificationPresentationClaimDto,
  NotificationPresentationFoldReason,
  NotificationSeverity,
} from "@mish/contracts";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import {
  FixtureNotificationCenter,
  FixtureNotificationClient,
} from "./fixture-notification-client";
import {
  NotificationDeliveryProvider,
  notificationPublication,
  useNotificationDelivery,
  type NotificationDeliveryContextValue,
} from "./notification-delivery";

class RejectingCompletionClient extends FixtureNotificationClient {
  override async completePresentation(
    _claim: NotificationPresentationClaimDto,
    _outcome: NotificationPresentationFoldReason,
  ) {
    const current = await this.getSnapshot();
    const revision = current.revision + 1;
    const snapshot = {
      notifications: current.notifications.map((record) => ({ ...record, revision })),
      revision,
    };
    this.receive(snapshot);
    return { accepted: false, snapshot };
  }
}

describe("Rust-authoritative notification delivery projection", () => {
  let delivery: NotificationDeliveryContextValue | null = null;

  function Probe() {
    const value = useNotificationDelivery();
    useEffect(() => {
      delivery = value;
    }, [value]);
    return null;
  }

  beforeEach(() => {
    delivery = null;
    loadAllLocales();
  });

  it("assigns a distinct occurrence key to independent publications of the same type", () => {
    const center = new FixtureNotificationCenter();
    const first = notificationPublication("profile.saved", { severity: "success" });
    const second = notificationPublication("profile.saved", { severity: "success" });

    expect(first.dedupeKey).not.toBe(second.dedupeKey);
    center.publish(first);
    const snapshot = center.publish(second);
    expect(snapshot.notifications).toHaveLength(2);
    expect(new Set(snapshot.notifications.map(({ id }) => id)).size).toBe(2);
  });

  it("does not allocate an occurrence key for an explicit lifecycle", () => {
    const randomUuid = vi.spyOn(crypto, "randomUUID");

    const publication = notificationPublication("system-proxy.drift", {
      data: { canLeave: true, canRepair: true, repairRequiresCore: false },
      dedupeKey: "system-proxy.drift",
      severity: "warning",
    });

    expect(publication.dedupeKey).toBe("system-proxy.drift");
    expect(randomUuid).not.toHaveBeenCalled();
    randomUuid.mockRestore();
  });

  it("claims a pre-GUI record, then keeps read state separate from its toast lifecycle", async () => {
    const center = new FixtureNotificationCenter();
    const publisher = new FixtureNotificationClient(center);
    await publisher.publish(
      notificationPublication("profile.created", {
        dedupeKey: "profile.created",
        severity: "success",
      }),
    );
    const client = new FixtureNotificationClient(center);
    const view = render(
      <TypesafeI18n locale="en">
        <NotificationDeliveryProvider client={client}>
          <Probe />
        </NotificationDeliveryProvider>
      </TypesafeI18n>,
    );
    await vi.waitFor(() => expect(delivery?.entries).toHaveLength(1));
    await vi.waitFor(() => expect(delivery?.toastEntries).toHaveLength(1));
    const preGuiId = delivery!.toastEntries[0]!.id;
    expect(delivery?.toastEntries[0]?.message).toBe("Profile created");

    act(() => delivery?.markRead([preGuiId]));
    await vi.waitFor(() =>
      expect(delivery?.entries.find((entry) => entry.id === preGuiId)?.read).toBe(true),
    );
    expect(delivery?.toastEntries[0]?.id).toBe(preGuiId);

    act(() => delivery?.completePresentation(preGuiId, "dismissed"));
    await vi.waitFor(() => expect(delivery?.toastEntries).toEqual([]));
    expect((await client.getSnapshot()).notifications[0]?.presentationState).toMatchObject({
      phase: "folded",
      foldReason: "dismissed",
    });

    await act(() =>
      publisher.publish(
        notificationPublication("traffic.connections-closed", {
          dedupeKey: "traffic.connections-closed",
          data: { count: 2 },
          severity: "success",
        }),
      ),
    );
    await vi.waitFor(() => expect(delivery?.toastEntries).toHaveLength(1));
    const id = delivery!.toastEntries[0]!.id;
    expect(delivery?.toastEntries[0]?.message).toBe("Closed 2 active connections");

    await act(() =>
      publisher.publish(
        notificationPublication("traffic.connections-closed", {
          dedupeKey: "traffic.connections-closed",
          data: { count: 3 },
          severity: "success",
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(delivery?.toastEntries[0]?.message).toBe("Closed 3 active connections"),
    );
    expect(delivery?.toastEntries).toHaveLength(1);
    expect(delivery?.toastEntries[0]?.id).toBe(id);
    act(() => delivery?.markRead([id]));
    await vi.waitFor(() =>
      expect(delivery?.entries.find((entry) => entry.id === id)?.read).toBe(true),
    );
    const authorityBeforeLocaleChange = await client.getSnapshot();
    const leaseBeforeLocaleChange = authorityBeforeLocaleChange.notifications.find(
      (entry) => entry.id === id,
    )?.presentationState;
    expect(leaseBeforeLocaleChange?.phase).toBe("presenting");

    view.rerender(
      <TypesafeI18n key="zh" locale="zh">
        <NotificationDeliveryProvider client={client}>
          <Probe />
        </NotificationDeliveryProvider>
      </TypesafeI18n>,
    );
    await vi.waitFor(() =>
      expect(delivery?.entries.find((entry) => entry.id === id)?.message).toBe(
        "已关闭 3 条活动连接",
      ),
    );
    expect(delivery?.entries).toHaveLength(2);
    expect(delivery?.toastEntries).toHaveLength(1);
    expect(delivery?.toastEntries[0]?.id).toBe(id);
    expect(delivery?.entries.find((entry) => entry.id === id)?.read).toBe(true);
    const authorityAfterLocaleChange = await client.getSnapshot();
    const leaseAfterLocaleChange = authorityAfterLocaleChange.notifications.find(
      (entry) => entry.id === id,
    )?.presentationState;
    expect(leaseAfterLocaleChange?.phase).toBe("presenting");
    if (
      leaseBeforeLocaleChange?.phase === "presenting" &&
      leaseAfterLocaleChange?.phase === "presenting"
    ) {
      expect(leaseAfterLocaleChange.leaseGeneration).toBeGreaterThan(
        leaseBeforeLocaleChange.leaseGeneration,
      );
    }
  });

  it("writes read and remove lifecycle through the shared authority", async () => {
    const center = new FixtureNotificationCenter();
    const first = new FixtureNotificationClient(center);
    const second = new FixtureNotificationClient(center);
    render(
      <TypesafeI18n locale="en">
        <NotificationDeliveryProvider client={first}>
          <Probe />
        </NotificationDeliveryProvider>
      </TypesafeI18n>,
    );
    await act(() =>
      second.publish(
        notificationPublication("profile.saved", {
          dedupeKey: "profile.saved",
          severity: "success",
        }),
      ),
    );
    await vi.waitFor(() => expect(delivery?.entries).toHaveLength(1));
    const id = delivery!.entries[0]!.id;
    act(() => delivery?.markRead([id]));
    await vi.waitFor(() =>
      expect(delivery?.entries.find((entry) => entry.id === id)?.read).toBe(true),
    );
    expect((await second.getSnapshot()).notifications[0]?.read).toBe(true);

    act(() => delivery?.remove(id));
    await vi.waitFor(() => expect(delivery?.entries).toEqual([]));
    expect((await second.getSnapshot()).notifications).toEqual([]);
  });

  it("keeps every occurrence severity through resolve, read, fold, reconnect, and retention", async () => {
    const center = new FixtureNotificationCenter();
    const publisher = new FixtureNotificationClient(center);
    const first = new FixtureNotificationClient(center);
    const second = new FixtureNotificationClient(center);
    const severities: readonly NotificationSeverity[] = ["error", "warning", "info", "success"];
    const retained: Array<{ id: string; severity: NotificationSeverity }> = [];

    for (const [index, severity] of severities.entries()) {
      const dedupeKey = `severity-history-${index}`;
      await publisher.publish(
        notificationPublication("profile.saved", {
          dedupeKey,
          pinned: true,
          severity,
        }),
      );
      const created = await publisher.getSnapshot();
      const id = created.notifications[0]!.id;
      center.markRead([id]);
      const firstClaim = center.claimPresentation(first.presentationIdentity).claim;
      expect(firstClaim?.id).toBe(id);

      const resolved = center.resolveByDedupeKey(dedupeKey);
      expect(resolved.notifications.find((record) => record.id === id)).toMatchObject({
        pinned: false,
        presentationState: { phase: "presenting" },
        read: true,
        resolved: true,
        severity,
      });

      first.reconnect();
      const reconnectClaim = center.claimPresentation(second.presentationIdentity).claim;
      expect(reconnectClaim?.id).toBe(id);
      const folded = center.completePresentation(
        second.presentationIdentity,
        reconnectClaim!,
        "dismissed",
      );
      expect(folded.accepted).toBe(true);
      expect(folded.snapshot.notifications.find((record) => record.id === id)).toMatchObject({
        presentationState: { foldReason: "dismissed", phase: "folded" },
        read: true,
        resolved: true,
        severity,
      });
      retained.push({ id, severity });
    }

    for (let index = 0; index < 128 - retained.length; index += 1) {
      await publisher.publish(
        notificationPublication("profile.saved", {
          dedupeKey: `severity-retention-${index}`,
          severity: "info",
        }),
      );
    }
    const withinBound = await publisher.getSnapshot();
    expect(withinBound.notifications).toHaveLength(128);
    for (const { id, severity } of retained) {
      expect(withinBound.notifications.find((record) => record.id === id)?.severity).toBe(severity);
    }

    await publisher.publish(
      notificationPublication("profile.saved", {
        dedupeKey: "severity-retention-overflow",
        severity: "info",
      }),
    );
    const overflow = await publisher.getSnapshot();
    expect(overflow.notifications).toHaveLength(128);
    expect(overflow.notifications.some((record) => record.id === retained[0]!.id)).toBe(false);
    for (const { id, severity } of retained.slice(1)) {
      expect(overflow.notifications.find((record) => record.id === id)?.severity).toBe(severity);
    }

    publisher.dispose();
    first.dispose();
    second.dispose();
  });

  it("reprojects a toast when a stale completion leaves its lease active", async () => {
    const center = new FixtureNotificationCenter();
    const publisher = new FixtureNotificationClient(center);
    const client = new RejectingCompletionClient(center);
    await publisher.publish(
      notificationPublication("profile.saved", {
        dedupeKey: "stale-completion",
        severity: "success",
      }),
    );
    const view = render(
      <TypesafeI18n locale="en">
        <NotificationDeliveryProvider client={client}>
          <Probe />
        </NotificationDeliveryProvider>
      </TypesafeI18n>,
    );
    await vi.waitFor(() => expect(delivery?.toastEntries).toHaveLength(1));
    const toast = delivery!.toastEntries[0]!;

    act(() => delivery?.completePresentation(toast.id, "dismissed"));

    await vi.waitFor(() =>
      expect(delivery?.toastEntries[0]).toMatchObject({
        id: toast.id,
        presentationAttempt: toast.presentationAttempt + 1,
      }),
    );

    view.unmount();
    client.dispose();
    publisher.dispose();
  });

  it("models one active lease, reconnect replacement, expiry, and stale acknowledgements", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const center = new FixtureNotificationCenter();
    const publisher = new FixtureNotificationClient(center);
    const first = new FixtureNotificationClient(center);
    const second = new FixtureNotificationClient(center);
    const third = new FixtureNotificationClient(center);
    await publisher.publish(
      notificationPublication("profile.saved", {
        dedupeKey: "lease-model",
        severity: "success",
      }),
    );
    await publisher.publish(
      notificationPublication("profile.created", {
        dedupeKey: "lease-queued",
        severity: "success",
      }),
    );

    const firstClaim = center.claimPresentation(first.presentationIdentity).claim;
    expect(firstClaim).not.toBeNull();
    expect((await first.getSnapshot()).notifications).toHaveLength(2);
    expect(center.claimPresentation(second.presentationIdentity).claim).toBeNull();
    const id = firstClaim!.id;
    const read = center.markRead([id]);
    expect(read.notifications.find((record) => record.id === id)?.presentationState.phase).toBe(
      "presenting",
    );

    first.dispose();
    const replacement = center.claimPresentation(second.presentationIdentity).claim;
    expect(replacement?.leaseGeneration).toBeGreaterThan(firstClaim!.leaseGeneration);
    expect(
      center.completePresentation(first.presentationIdentity, firstClaim!, "dismissed").accepted,
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    const afterExpiry = center.claimPresentation(third.presentationIdentity).claim;
    expect(afterExpiry?.leaseGeneration).toBeGreaterThan(replacement!.leaseGeneration);
    const timedOut = center.completePresentation(
      third.presentationIdentity,
      afterExpiry!,
      "timed-out",
    );
    expect(timedOut.accepted).toBe(true);
    expect(
      timedOut.snapshot.notifications.find((record) => record.id === id)?.presentationState,
    ).toMatchObject({ foldReason: "timed-out", phase: "folded" });
    const nextQueuedClaim = center.claimPresentation(second.presentationIdentity).claim;
    expect(nextQueuedClaim?.id).not.toBe(id);
    const afterRemoval = center.remove(id).notifications;
    expect(afterRemoval).toHaveLength(1);
    expect(afterRemoval[0]?.id).toBe(nextQueuedClaim?.id);

    publisher.dispose();
    second.dispose();
    third.dispose();
  });
});
