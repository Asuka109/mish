import {
  applicationNotificationKindSchema,
  NotificationRecordSchema,
  type ApplicationActionId,
  type ApplicationNotification,
  type ApplicationNotificationDataByKind,
  type ApplicationNotificationKind,
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
  "profile.activation-asn-progress": { asset: "asn" },
  "profile.activation-failed": { failure: "missing-binary" },
  "profile.activation-geoip-failed": { asset: "geo-ip", outcome: "failed" },
  "profile.activation-geoip-progress": { asset: "geo-ip" },
  "profile.activation-geosite-failed": { asset: "geo-site", outcome: "failed" },
  "profile.activation-geosite-progress": { asset: "geo-site" },
  "profile.activation-listener-conflict": { endpoint: "127.0.0.1:7890" },
  "profile.activation-mmdb-failed": { asset: "mmdb", outcome: "failed" },
  "profile.activation-mmdb-progress": { asset: "mmdb" },
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
  overrides: { pinned?: boolean; resolved?: boolean } = {},
) {
  return notificationRecord({
    id: `record:${kind}`,
    pinned: overrides.pinned,
    presentation: { actionIds: [...actionIds], data, kind } as ApplicationNotification,
    resolved: overrides.resolved,
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

  it("derives lifecycle without storing localized copy", () => {
    const progress = presentNotification(
      record("profile.activation-geosite-progress", { asset: "geo-site" }, [], { pinned: true }),
      i18nObject("en"),
    );
    expect(progress.duration).toBe(Number.POSITIVE_INFINITY);
    expect(progress.removable).toBe(false);

    const completed = presentNotification(
      record("profile.activation-geosite-progress", { asset: "geo-site" }, [], {
        resolved: true,
      }),
      i18nObject("en"),
    );
    expect(completed.toast).toBe("dismiss");
    expect(completed.removable).toBe(true);
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
