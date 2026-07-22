import type { EventRecordDto, ProfileSnapshotDto } from "@mish/contracts";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import {
  geodataProgressNotificationId,
  NotificationBubble,
} from "../components/notification-bubble";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { EventsProvider } from "./events-provider";
import { createFixtureEventsClient } from "./fixture-events-client";
import { FixtureProfileClient } from "./fixture-profile-client";
import { ProductProvider } from "./product-provider";
import { ProfileProvider } from "./profile-provider";
import {
  NotificationDeliveryProvider,
  useNotificationDelivery,
  type NotificationDeliveryContextValue,
} from "./notification-delivery";

const { dismissNotificationToast, presentNotificationToast } = vi.hoisted(() => ({
  dismissNotificationToast: vi.fn(),
  presentNotificationToast: vi.fn(),
}));

vi.mock("./sonner-notification-adapter", () => ({
  dismissNotificationToast,
  presentNotificationToast,
}));

class MutableProfileClient extends FixtureProfileClient {
  private listener: ((snapshot: ProfileSnapshotDto) => void) | null = null;

  constructor(private snapshot: ProfileSnapshotDto) {
    super();
  }

  override async getSnapshot() {
    return structuredClone(this.snapshot);
  }

  publish(snapshot: ProfileSnapshotDto) {
    this.snapshot = structuredClone(snapshot);
    this.listener?.(structuredClone(snapshot));
  }

  override subscribeSnapshots(listener: (snapshot: ProfileSnapshotDto) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

function event(id: string, sequence: number): EventRecordDto {
  return {
    detail: "Resolve the failure and retry",
    id,
    level: "error",
    message: "Profile activation failed",
    notificationKind: "profile-activation-failure",
    observedAt: sequence,
    sequence,
    source: "application",
  };
}

describe("authoritative notification delivery", () => {
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
    presentNotificationToast.mockClear();
    dismissNotificationToast.mockClear();
  });

  it("restores history without replaying toast and presents only new Rust events", () => {
    render(
      <NotificationDeliveryProvider>
        <Probe />
      </NotificationDeliveryProvider>,
    );
    const first = event("session-1:1", 1);
    act(() => {
      delivery?.setSession("session-1");
      delivery?.reconcileExternalNotifications([{ ...first, detail: first.detail ?? undefined }]);
    });
    expect(delivery?.entries.map(({ id }) => id)).toEqual([first.id]);
    expect(presentNotificationToast).not.toHaveBeenCalled();

    const second = event("session-1:2", 2);
    act(() => {
      delivery?.reconcileExternalNotifications(
        [first, second].map((item) => ({ ...item, detail: item.detail ?? undefined })),
      );
    });
    expect(delivery?.entries.map(({ id }) => id)).toEqual([second.id, first.id]);
    expect(presentNotificationToast).toHaveBeenCalledTimes(1);
    expect(presentNotificationToast.mock.calls[0]?.[0]).toMatchObject({
      id: second.id,
      source: "event",
    });

    act(() => {
      delivery?.reconcileExternalNotifications([
        { ...first, detail: first.detail ?? undefined },
        { ...second, detail: "Localized recovery guidance", message: "Localized failure" },
      ]);
    });
    expect(presentNotificationToast).toHaveBeenCalledTimes(2);
    expect(presentNotificationToast.mock.calls[1]?.[0]).toMatchObject({
      id: second.id,
      message: "Localized failure",
    });

    act(() => {
      delivery?.setSession("session-2");
      delivery?.reconcileExternalNotifications([
        { ...event("session-2:1", 1), detail: "Resolve the failure and retry" },
      ]);
    });
    expect(presentNotificationToast).toHaveBeenCalledTimes(2);
  });

  it("keeps raw Mihomo DNS diagnostics in Events without a center entry or toast", async () => {
    loadAllLocales();
    const dnsWarning: EventRecordDto = {
      detail: null,
      id: "session-1:1",
      level: "warning",
      message: "dial DNS failed for an internal Mihomo lookup",
      notificationKind: null,
      observedAt: 1,
      sequence: 1,
      source: "core",
    };
    const events = createFixtureEventsClient();
    const eventSnapshot = await events.getSnapshot();
    eventSnapshot.events = [dnsWarning];
    eventSnapshot.sequence = 1;
    act(() => events.publishSnapshot(eventSnapshot));
    render(
      <TypesafeI18n locale="en">
        <MemoryRouter>
          <ProductProvider>
            <ProfileProvider>
              <EventsProvider client={events}>
                <NotificationDeliveryProvider>
                  <Probe />
                  <NotificationBubble />
                </NotificationDeliveryProvider>
              </EventsProvider>
            </ProfileProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>,
    );

    await vi.waitFor(() => expect(delivery).not.toBeNull());
    expect(delivery?.entries).toEqual([]);
    expect(presentNotificationToast).not.toHaveBeenCalled();
  });

  it("keeps one localized geodata notification through progress, failure, retry, and relaunch", async () => {
    loadAllLocales();
    const base = await new FixtureProfileClient().getSnapshot();
    const pending: ProfileSnapshotDto = {
      ...base,
      activation: {
        ...base.activation,
        availability: "available",
        commandId: "command-1",
        evidence: { asset: "geo-site", kind: "geodata-preparing" },
        operation: "activate",
        phase: "pending",
        targetProfileId: base.profiles[0]!.id,
      },
    };
    const profiles = new MutableProfileClient(pending);
    const events = createFixtureEventsClient();
    const initialEvents = await events.getSnapshot();
    initialEvents.events = [];
    initialEvents.sequence = 0;
    events.publishSnapshot(initialEvents);
    const view = render(
      <TypesafeI18n locale="en">
        <MemoryRouter>
          <ProductProvider>
            <ProfileProvider client={profiles}>
              <EventsProvider client={events}>
                <NotificationDeliveryProvider>
                  <Probe />
                  <NotificationBubble />
                </NotificationDeliveryProvider>
              </EventsProvider>
            </ProfileProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>,
    );
    await vi.waitFor(() => {
      expect(delivery?.entries).toHaveLength(1);
      expect(delivery?.entries[0]).toMatchObject({
        detail: "The first download may take a few minutes.",
        duration: Number.POSITIVE_INFINITY,
        id: geodataProgressNotificationId,
        message: "Preparing geographic rule data before activation…",
      });
    });
    act(() => delivery?.dismiss(geodataProgressNotificationId));
    expect(dismissNotificationToast).toHaveBeenCalledWith(geodataProgressNotificationId);
    expect(delivery?.entries).toHaveLength(1);
    act(() =>
      profiles.publish({
        ...pending,
        activation: { ...pending.activation, evidence: null, failure: null, phase: "success" },
      }),
    );
    await vi.waitFor(() => expect(delivery?.entries).toHaveLength(0));
    act(() =>
      profiles.publish({
        ...pending,
        activation: { ...pending.activation, commandId: "command-2" },
      }),
    );
    await vi.waitFor(() => expect(delivery?.entries).toHaveLength(1));
    const failureProgressObservedAt = delivery!.entries[0]!.observedAt;

    const failed = {
      ...pending,
      activation: {
        ...pending.activation,
        commandId: "command-2",
        evidence: { asset: "geo-site", kind: "geodata-failed" } as const,
        failure: "geodata-failed" as const,
        phase: "failure" as const,
      },
    } satisfies ProfileSnapshotDto;
    const eventSnapshot = await events.getSnapshot();
    eventSnapshot.events = [
      {
        detail: "raw backend guidance",
        id: `${eventSnapshot.sessionId}:1`,
        level: "error",
        message: "raw backend failure",
        notificationKind: "profile-activation-geodata",
        observedAt: failureProgressObservedAt + 1,
        sequence: 1,
        source: "application",
      },
    ];
    eventSnapshot.sequence = 1;
    act(() => events.publishSnapshot(eventSnapshot));
    await vi.waitFor(() => {
      expect(delivery?.entries).toHaveLength(1);
      expect(delivery?.entries[0]).toMatchObject({
        detail: "Check your network connection and retry activation.",
        message: "Mihomo could not prepare the geographic rule data required by this profile.",
        source: "event",
      });
    });
    await act(async () => {
      profiles.publish(failed);
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    act(() =>
      profiles.publish({
        ...pending,
        activation: { ...pending.activation, commandId: "command-3" },
      }),
    );
    await vi.waitFor(() => {
      expect(
        delivery?.entries.filter(({ id }) => id === geodataProgressNotificationId),
      ).toHaveLength(1);
    });
    const retryProgressObservedAt = delivery!.entries.find(
      ({ id }) => id === geodataProgressNotificationId,
    )!.observedAt;

    act(() =>
      profiles.publish({
        ...pending,
        activation: {
          ...pending.activation,
          commandId: "command-3",
          evidence: { asset: "mmdb", kind: "geodata-timeout" },
          failure: "geodata-timeout",
          phase: "failure",
        },
      }),
    );
    eventSnapshot.events.push({
      detail: "raw timeout detail",
      id: `${eventSnapshot.sessionId}:2`,
      level: "error",
      message: "Profile geodata preparation timed out",
      notificationKind: "profile-activation-geodata",
      observedAt: retryProgressObservedAt + 1,
      sequence: 2,
      source: "application",
    });
    eventSnapshot.sequence = 2;
    act(() => events.publishSnapshot(eventSnapshot));
    await vi.waitFor(() => {
      expect(delivery?.entries.filter(({ source }) => source === "event")).toHaveLength(2);
      expect(delivery?.entries[0]?.message).toBe(
        "Geographic rule data was not ready before the activation deadline.",
      );
      expect(delivery?.entries.some(({ id }) => id === geodataProgressNotificationId)).toBe(false);
    });

    act(() =>
      events.publishSnapshot({ ...eventSnapshot, events: [], sequence: 0, sessionId: "relaunch" }),
    );
    await vi.waitFor(() => expect(delivery?.entries).toHaveLength(0));
    view.unmount();
  });
});
