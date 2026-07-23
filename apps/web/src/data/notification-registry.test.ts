import { KnownNotificationTypeSchema } from "@mish/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { i18nObject } from "../i18n/i18n-util";
import { notificationRecord } from "./notification-delivery";
import { presentNotification } from "./notification-registry";

beforeAll(loadAllLocales);

describe("notification presentation registry", () => {
  it("covers every current notification type without the unknown fallback", () => {
    const LL = i18nObject("en");
    for (const type of KnownNotificationTypeSchema.options) {
      const presentation = presentNotification(
        notificationRecord({ id: `record:${type.replaceAll(".", "-")}`, type }),
        LL,
      );
      expect(presentation.message, type).not.toBe(LL.notifications.unknownMessage());
    }
  });

  it("renders English and Chinese from the same semantic record", () => {
    const record = notificationRecord({
      id: "notification:1",
      params: { count: 3 },
      type: "traffic.connections-closed",
    });
    expect(presentNotification(record, i18nObject("en")).message).toBe(
      "Closed 3 active connections",
    );
    expect(presentNotification(record, i18nObject("zh")).message).toBe("已关闭 3 条活动连接");
  });

  it("interpolates bounded parameters and derives deterministic interactive actions", () => {
    const LL = i18nObject("en");
    const route = presentNotification(
      notificationRecord({
        id: "notification:2",
        params: { child: "Direct" },
        type: "route.selection-failed",
      }),
      LL,
    );
    expect(route.message).toContain("Direct");

    const drift = presentNotification(
      notificationRecord({
        id: "notification:3",
        params: { canLeave: true, canRepair: true, repairRequiresCore: false },
        type: "system-proxy.drift",
      }),
      LL,
    );
    expect(drift.actions.map(({ id }) => id)).toEqual(["repair", "leave-as-is"]);
  });

  it("derives pinned toast and center lifecycles from Rust metadata", () => {
    const progress = presentNotification(
      notificationRecord({
        id: "notification:progress",
        params: { asset: "geo-site" },
        pinned: true,
        type: "profile.activation-geodata-progress",
      }),
      i18nObject("en"),
    );
    expect(progress.duration).toBe(Number.POSITIVE_INFINITY);
    expect((progress as typeof progress & { removable?: boolean }).removable).toBe(false);

    const completed = presentNotification(
      notificationRecord({
        id: "notification:progress",
        params: { asset: "geo-site" },
        pinned: false,
        resolved: true,
        type: "profile.activation-geodata-progress",
      }),
      i18nObject("en"),
    );
    expect(completed.toast).toBe("dismiss");
    expect((completed as typeof completed & { removable?: boolean }).removable).toBe(true);

    const ordinaryFailure = presentNotification(
      notificationRecord({
        id: "notification:failure",
        params: { endpoint: "127.0.0.1:7890" },
        type: "profile.activation-listener-conflict",
      }),
      i18nObject("en"),
    );
    expect(ordinaryFailure.duration).toBeUndefined();
  });

  it("uses a safe fallback for unknown Rust-native types without exposing parameters", () => {
    const LL = i18nObject("en");
    const presentation = presentNotification(
      notificationRecord({
        id: "notification:4",
        params: { value: "must not render" },
        type: "future.notification",
      }),
      LL,
    );
    expect(presentation.title).toBe("Notification");
    expect(presentation.message).toBe(LL.notifications.unknownMessage());
    expect(JSON.stringify(presentation)).not.toContain("must not render");
  });
});
