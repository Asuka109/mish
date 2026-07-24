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

    const startupFailure = presentNotification(
      notificationRecord({
        id: "notification:startup-failure",
        params: { failure: "core-unhealthy" },
        type: "system-proxy.failed",
      }),
      LL,
    );
    expect(startupFailure.actions).toEqual([
      { diagnosticFailure: "core-unhealthy", id: "open-diagnostics", label: "Open Diagnostics" },
    ]);
    expect(
      presentNotification(
        notificationRecord({
          id: "notification:startup-failure-zh",
          params: { failure: "core-unhealthy" },
          type: "system-proxy.failed",
        }),
        i18nObject("zh"),
      ).actions,
    ).toEqual([{ diagnosticFailure: "core-unhealthy", id: "open-diagnostics", label: "打开诊断" }]);
  });

  it("keeps takeover rejections redacted and offers the fixed native settings action", () => {
    const presentation = presentNotification(
      notificationRecord({
        id: "notification:takeover-rejected",
        params: {
          failure: "takeover-rejected",
          host: "must-not-render.example",
          pacUrl: "https://must-not-render.example/proxy.pac",
          takeoverReason: "protected-pac",
        },
        type: "capture.failure",
      }),
      i18nObject("en"),
    );
    expect(presentation.actions).toEqual([
      { id: "open-system-proxy-settings", label: "Review Proxy Settings" },
      {
        id: "show-system-proxy-settings-steps",
        label: "Show Manual Steps",
        tone: "secondary",
      },
    ]);
    expect(
      presentNotification(
        notificationRecord({
          id: "notification:takeover-rejected-zh",
          params: {
            failure: "takeover-rejected",
            takeoverReason: "protected-auto-discovery",
          },
          type: "capture.failure",
        }),
        i18nObject("zh"),
      ).actions,
    ).toEqual([
      { id: "open-system-proxy-settings", label: "查看代理设置" },
      {
        id: "show-system-proxy-settings-steps",
        label: "显示手动步骤",
        tone: "secondary",
      },
    ]);
    expect(JSON.stringify(presentation)).not.toContain("must-not-render");
  });

  it("presents GeoSite and MMDB as independent notification types", () => {
    const LL = i18nObject("en");
    const geosite = presentNotification(
      notificationRecord({
        id: "notification:geosite",
        params: { asset: "geo-site" },
        type: "profile.activation-geosite-progress",
      }),
      LL,
    );
    const mmdb = presentNotification(
      notificationRecord({
        id: "notification:mmdb",
        params: { asset: "mmdb" },
        type: "profile.activation-mmdb-progress",
      }),
      LL,
    );

    expect(geosite.message).toBe(LL.profiles.geodataPreparing({ asset: "GeoSite" }));
    expect(mmdb.message).toBe(LL.profiles.geodataPreparing({ asset: "MMDB" }));
  });

  it("derives pinned toast and center lifecycles from Rust metadata", () => {
    const progress = presentNotification(
      notificationRecord({
        id: "notification:progress",
        params: { asset: "geo-site" },
        pinned: true,
        type: "profile.activation-geosite-progress",
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
        type: "profile.activation-geosite-progress",
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
