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
