import {
  applicationNotificationKindSchema,
  NotificationRecordSchema,
  type ApplicationActionId,
  type ApplicationNotification,
  type ApplicationNotificationDataByKind,
  type ApplicationNotificationKind,
  type NotificationSeverity,
} from "@mish/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { i18nObject } from "../i18n/i18n-util";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { notificationRecord } from "./notification-delivery";
import { presentNotification } from "./notification-registry";

beforeAll(loadAllLocales);

const sampleData = {
  "capture.failure": { failure: "core-unhealthy" },
  "local-proxy.feedback": { outcome: "ready" },
  "onboarding.welcome": { prompt: true },
  "profile.activation-asn-failed": { asset: "asn", outcome: "failed" },
  "profile.activation-asn-progress": { asset: "asn", outcome: "preparing" },
  "profile.activation-failed": { failure: "missing-binary" },
  "profile.activation-geoip-failed": { asset: "geo-ip", outcome: "failed" },
  "profile.activation-geoip-progress": { asset: "geo-ip", outcome: "preparing" },
  "profile.activation-geosite-failed": { asset: "geo-site", outcome: "failed" },
  "profile.activation-geosite-progress": { asset: "geo-site", outcome: "preparing" },
  "profile.activation-listener-conflict": { endpoint: "127.0.0.1:7890" },
  "profile.activation-mmdb-failed": { asset: "mmdb", outcome: "failed" },
  "profile.activation-mmdb-progress": { asset: "mmdb", outcome: "preparing" },
  "profile.create-failed": {},
  "profile.created": {},
  "profile.detach-failed": {},
  "profile.detached": {},
  "profile.file-action-failed": {},
  "profile.import-failed": {},
  "profile.patch-load-failed": {},
  "profile.patch-save-failed": {},
  "profile.patch-saved": {},
  "profile.refresh-failed": {},
  "profile.save-failed": {},
  "profile.saved": {},
  "profile.schedule-failed": {},
  "profile.subscription-updated": {},
  "profile.switch-failed": {},
  "route.selection-failed": { child: "Direct" },
  "route.old-child-cleanup": {
    catalogRevision: "a".repeat(64),
    closedCount: 2,
    controllerSessionRevision: 7,
    failedCount: 0,
    membershipRevision: "b".repeat(64),
    mode: "old-direct-child",
    phase: "completed",
    targetCount: 2,
  },
  "service.defaults-restored": {},
  "service.removed": {},
  "service.saved": { operation: "updated" },
  "settings.operation-failed": { failure: "persistence" },
  "status.operation-failed": {},
  "system-proxy.drift": {
    canLeave: true,
    canRepair: true,
    repairRequiresCore: false,
  },
  "system-proxy.failed": { failure: "core-unhealthy" },
  "traffic.connection-closed": {},
  "traffic.connections-closed": { count: 3 },
  "traffic.operation-failed": { failure: "timeout" },
  "tun-helper.lifecycle": { operation: "install", outcome: "applied" },
  "tun.drift": {},
  "tun.failed": {},
} satisfies ApplicationNotificationDataByKind;

function record<K extends ApplicationNotificationKind>(
  kind: K,
  data: ApplicationNotificationDataByKind[K],
  actionIds: readonly ApplicationActionId[] = [],
  overrides: { pinned?: boolean; resolved?: boolean; severity?: NotificationSeverity } = {},
) {
  return notificationRecord({
    id: `record:${kind}`,
    pinned: overrides.pinned,
    presentation: { actionIds: [...actionIds], data, kind } as ApplicationNotification,
    resolved: overrides.resolved,
    ...(overrides.severity ? { severity: overrides.severity } : {}),
  });
}

describe("notification presentation registry", () => {
  it("exhaustively presents every generated notification kind", () => {
    const LL = i18nObject("en");
    for (const kind of applicationNotificationKindSchema.options) {
      expect(presentNotification(record(kind, sampleData[kind]), LL).message).toBeTruthy();
    }
  });

  it("re-localizes the same retained semantic record", () => {
    const retained = record("traffic.connections-closed", { count: 3 });
    expect(presentNotification(retained, i18nObject("en")).message).toBe(
      "Closed 3 active connections",
    );
    expect(presentNotification(retained, i18nObject("zh")).message).toBe("已关闭 3 条活动连接");
    expect(retained.id).toBe("record:traffic.connections-closed");
  });

  it("uses transported stable action IDs and typed data", () => {
    const LL = i18nObject("en");
    const drift = presentNotification(
      record("system-proxy.drift", { canLeave: true, canRepair: true, repairRequiresCore: false }, [
        "repair",
        "leave-as-is",
      ]),
      LL,
    );
    expect(drift.actions.map(({ id }) => id)).toEqual(["repair", "leave-as-is"]);

    const failure = presentNotification(
      record("profile.activation-failed", { failure: "missing-binary" }, [
        "retry-profile-activation",
      ]),
      LL,
    );
    expect(failure.actions).toEqual([
      { id: "retry-profile-activation", label: "Retry Activation" },
    ]);
  });

  it("attributes an unavailable privileged Core service to Virtual Interface setup", () => {
    const notification = record("profile.activation-failed", {
      failure: "tun-helper-unavailable",
    });
    const failure = presentNotification(notification, i18nObject("en"));

    expect(failure.message).toBe(
      "Virtual Interface could not start because its system component is not installed or unavailable. Install or repair it in Settings, then retry.",
    );
    expect(failure.message).not.toContain("selected profile");
    expect(failure.actions).toEqual([]);
    expect(presentNotification(notification, i18nObject("zh")).message).toBe(
      "虚拟网卡无法启动，因为所需的系统组件尚未安装或当前不可用。请先到“设置”中安装或修复系统组件，然后重试。",
    );
  });

  it("attributes foreign TUN network state to the owning application", () => {
    const notification = record(
      "profile.activation-failed",
      { failure: "tun-network-ownership-conflict" },
      ["retry-profile-activation"],
    );
    const failure = presentNotification(notification, i18nObject("en"));

    expect(failure.message).toBe(
      "Virtual Interface could not start because another app owns the active TUN, DNS, or routes. Mish left that network state unchanged. Stop the other app's network capture, then retry.",
    );
    expect(failure.message).not.toContain("selected profile");
    expect(failure.actions).toEqual([
      { id: "retry-profile-activation", label: "Retry Activation" },
    ]);
    expect(presentNotification(notification, i18nObject("zh")).message).toBe(
      "虚拟网卡无法启动，因为其他应用正在接管 TUN、DNS 或路由。Mish 未改动这些网络状态。请先停止其他应用的网络接管，然后重试。",
    );
  });

  it("keeps takeover evidence redacted and uses only allowlisted actions", () => {
    const presentation = presentNotification(
      record("capture.failure", { failure: "takeover-rejected", takeoverReason: "protected-pac" }, [
        "open-system-proxy-settings",
        "show-system-proxy-settings-steps",
      ]),
      i18nObject("en"),
    );
    expect(presentation.actions.map(({ id }) => id)).toEqual([
      "open-system-proxy-settings",
      "show-system-proxy-settings-steps",
    ]);
    expect(JSON.stringify(presentation)).not.toContain("protected-pac");
  });

  it("presents the Rust-owned missing configuration failure with one Profiles action", () => {
    const presentation = presentNotification(
      record("capture.failure", { failure: "configuration-required" }, ["open-profiles"]),
      i18nObject("en"),
    );

    expect(presentation.title).toBe("Profile configuration required");
    expect(presentation.message).toBe(
      "Choose or import a Profile configuration before launching the proxy.",
    );
    expect(presentation.actions).toEqual([{ id: "open-profiles", label: "Open Profiles" }]);
  });

  it("presents TUN drift without System Proxy recovery copy or actions", () => {
    const presentation = presentNotification(
      record("capture.failure", { captureMode: "tun", failure: "external-drift" }),
      i18nObject("zh"),
    );

    expect(presentation.message).toBe("虚拟网卡的实际状态与 Mish 中的选择不一致。");
    expect(presentation.actions).toEqual([]);
  });

  it("presents a failed TUN confirmation without Core or System Proxy terminology", () => {
    const presentation = presentNotification(
      record("capture.failure", { captureMode: "tun", failure: "confirmation-failed" }),
      i18nObject("zh"),
    );

    expect(presentation.message).toBe("虚拟网卡没有成功开启，已恢复之前的网络状态。");
    expect(presentation.message).not.toContain("Core");
    expect(presentation.message).not.toContain("系统代理");
    expect(presentation.actions).toEqual([]);
  });

  it("derives lifecycle without storing localized copy", () => {
    const progress = presentNotification(
      record(
        "profile.activation-geosite-progress",
        { asset: "geo-site", outcome: "preparing" },
        [],
        { pinned: true },
      ),
      i18nObject("en"),
    );
    expect(progress.duration).toBe(Number.POSITIVE_INFINITY);
    expect(progress.removable).toBe(false);

    const completed = presentNotification(
      record(
        "profile.activation-geosite-progress",
        { asset: "geo-site", outcome: "prepared" },
        [],
        { resolved: true, severity: "success" },
      ),
      i18nObject("en"),
    );
    expect(completed.message).toBe("GeoSite is ready for activation.");
    expect(completed.toast).toBe("dismiss");
    expect(completed.removable).toBe(true);

    const legacyResolved = presentNotification(
      record("profile.activation-geosite-progress", { asset: "geo-site" }, [], {
        resolved: true,
        severity: "info",
      }),
      i18nObject("en"),
    );
    expect(legacyResolved.message).toBe("Preparing GeoSite before activation…");
    expect(legacyResolved.level).toBe("info");
    expect(legacyResolved.toast).toBe("dismiss");
  });

  it("keeps resolved history separate from explicit success outcomes", () => {
    const LL = i18nObject("en");
    for (const severity of ["error", "warning", "info", "success"] as const) {
      const resolved = presentNotification(
        record("capture.failure", { failure: "core-unhealthy" }, ["repair"], {
          resolved: true,
          severity,
        }),
        LL,
      );
      expect(resolved.level).toBe(severity);
      expect(resolved.message).toBe(LL.capture.systemProxyCoreFailure());
      expect(resolved.message).not.toBe(LL.capture.systemProxyApplied());
      expect(resolved.actions).toEqual([]);
      expect(resolved.toast).toBe("dismiss");
    }

    const explicitSuccess = presentNotification(
      record(
        "profile.activation-geosite-progress",
        { asset: "geo-site", outcome: "prepared" },
        [],
        { resolved: true, severity: "success" },
      ),
      LL,
    );
    expect(explicitSuccess.level).toBe("success");
    expect(explicitSuccess.message).toBe("GeoSite is ready for activation.");
  });

  it("keeps Internal TUN finalization in the same pending presentation", () => {
    const pending = presentNotification(
      record("tun-helper.lifecycle", { operation: "repair", outcome: "pending" }, [], {
        pinned: true,
      }),
      i18nObject("en"),
    );
    const finalizing = presentNotification(
      record("tun-helper.lifecycle", { operation: "repair", outcome: "finalizing" }, [], {
        pinned: true,
      }),
      i18nObject("en"),
    );

    expect(finalizing.message).toBe(pending.message);
    expect(finalizing.duration).toBe(Number.POSITIVE_INFINITY);
    expect(finalizing.removable).toBe(false);
  });

  it("presents distinct actionable Helper-removal outcomes", () => {
    const expected = {
      "authorization-cancelled":
        "Administrator authorization was cancelled. The Helper remains installed; try again when you are ready.",
      "authorization-failed":
        "macOS did not authorize Helper removal. Confirm administrator access and try again.",
      "observation-incomplete":
        "Mish could not confirm that Core, the virtual interface, routes, and DNS were clean, so the Helper was not removed. Restore the network state or restart Mish, then try again.",
      "removal-failed":
        "The Helper could not be removed and remains installed. Restart Mish, then open Settings and try again.",
      removed:
        "The Helper was removed after Mish confirmed that Core, the virtual interface, routes, and DNS were clean.",
      "shutdown-failed":
        "Mish could not stop the virtual interface safely, so the Helper was not removed. Turn off the virtual interface and try again.",
    } as const;

    for (const [outcome, message] of Object.entries(expected)) {
      const presentation = presentNotification(
        record("tun-helper.lifecycle", { operation: "remove", outcome }),
        i18nObject("en"),
      );
      expect(presentation.message).toBe(message);
      if (outcome !== "removed") {
        expect(presentation.message).not.toContain(outcome);
      }
    }
    expect(new Set(Object.values(expected)).size).toBe(Object.keys(expected).length);
  });

  it("presents Helper preparation failures as actionable user-facing recovery", () => {
    const notification = record("tun-helper.lifecycle", {
      failure: "preparation-failed",
      operation: "repair",
      outcome: "recovery-required",
    });

    const presentation = presentNotification(notification, i18nObject("zh"));

    expect(presentation.message).toBe(
      "修复系统组件未完成。Mish 无法准备或验证安装所需文件，因此没有请求管理员授权。请重新启动 Mish 后重试；若仍失败，请重新安装当前版本。",
    );
    expect(presentation.message).not.toContain("preparation-failed");
    expect(presentation.message).not.toContain("Mihomo");
    expect(presentation.message).not.toContain("Rust");

    const english = presentNotification(notification, i18nObject("en"));
    expect(english.message).toBe(
      "Repair Helper could not be completed. Mish could not prepare or verify the files required for installation, so administrator approval was not requested. Restart Mish and retry; if it still fails, reinstall this version.",
    );
    expect(english.message).not.toContain("preparation-failed");
  });

  it("rejects legacy and incomplete transport shapes", () => {
    expect(
      NotificationRecordSchema.safeParse({
        createdRevision: 1,
        dedupeKey: "legacy",
        id: "legacy",
        observedAt: 1,
        params: { count: 1 },
        pinned: false,
        read: false,
        resolved: false,
        revision: 1,
        severity: "info",
        type: "traffic.connections-closed",
      }).success,
    ).toBe(false);
    expect(
      NotificationRecordSchema.safeParse({
        createdRevision: 1,
        dedupeKey: "incomplete",
        id: "incomplete",
        observedAt: 1,
        pinned: false,
        presentation: {
          actionIds: [],
          data: {},
          kind: "traffic.connections-closed",
        },
        read: false,
        resolved: false,
        revision: 1,
        severity: "info",
      }).success,
    ).toBe(false);
  });
});
