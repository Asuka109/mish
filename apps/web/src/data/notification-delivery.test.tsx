import { act, render } from "@testing-library/react";
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
      dedupeKey: "system-proxy.drift",
      severity: "warning",
    });

    expect(publication.dedupeKey).toBe("system-proxy.drift");
    expect(randomUuid).not.toHaveBeenCalled();
    randomUuid.mockRestore();
  });

  it("hydrates the baseline without a toast and observes one new same-ID projection", async () => {
    const center = new FixtureNotificationCenter();
    const publisher = new FixtureNotificationClient(center);
    await publisher.publish(
      notificationPublication("profile.created", {
        dedupeKey: "profile.created",
        severity: "success",
      }),
    );
    const client = new FixtureNotificationClient(center);
    render(
      <TypesafeI18n locale="en">
        <NotificationDeliveryProvider client={client}>
          <Probe />
        </NotificationDeliveryProvider>
      </TypesafeI18n>,
    );
    await vi.waitFor(() => expect(delivery?.entries).toHaveLength(1));
    expect(delivery?.toastEntries).toEqual([]);

    await act(() =>
      publisher.publish(
        notificationPublication("traffic.connections-closed", {
          dedupeKey: "traffic.connections-closed",
          params: { count: 2 },
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
          params: { count: 3 },
          severity: "success",
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(delivery?.toastEntries[0]?.message).toBe("Closed 3 active connections"),
    );
    expect(delivery?.toastEntries).toHaveLength(1);
    expect(delivery?.toastEntries[0]?.id).toBe(id);
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
});
