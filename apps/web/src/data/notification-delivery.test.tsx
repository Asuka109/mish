import type { EventRecordDto } from "@mish/contracts";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotificationDeliveryProvider,
  useNotificationDelivery,
  type NotificationDeliveryContextValue,
} from "./notification-delivery";

const { presentNotificationToast } = vi.hoisted(() => ({ presentNotificationToast: vi.fn() }));

vi.mock("./sonner-notification-adapter", () => ({
  dismissNotificationToast: vi.fn(),
  presentNotificationToast,
}));

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
      delivery?.ingestExternalEvents([first], [{ ...first, detail: first.detail ?? undefined }]);
    });
    expect(delivery?.entries.map(({ id }) => id)).toEqual([first.id]);
    expect(presentNotificationToast).not.toHaveBeenCalled();

    const second = event("session-1:2", 2);
    act(() => {
      delivery?.ingestExternalEvents(
        [first, second],
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
      delivery?.ingestExternalEvents(
        [first, second],
        [{ ...second, detail: "Localized recovery guidance", message: "Localized failure" }],
      );
    });
    expect(presentNotificationToast).toHaveBeenCalledTimes(2);
    expect(presentNotificationToast.mock.calls[1]?.[0]).toMatchObject({
      id: second.id,
      message: "Localized failure",
    });

    act(() => {
      delivery?.setSession("session-2");
      delivery?.ingestExternalEvents(
        [event("session-2:1", 1)],
        [{ ...event("session-2:1", 1), detail: "Resolve the failure and retry" }],
      );
    });
    expect(presentNotificationToast).toHaveBeenCalledTimes(2);
  });
});
