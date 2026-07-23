import {
  KnownNotificationTypeSchema,
  type NotificationRecordDto,
  type NotificationSeverity,
} from "@mish/contracts";
import type { TranslationFunctions } from "../i18n/i18n-types";
import { trafficFailureMessage } from "./traffic-failure-message";

export type NotificationActionTone = "primary" | "secondary" | "destructive";

export interface NotificationActionDescriptor {
  id: string;
  label: string;
  tone?: NotificationActionTone;
}

export interface DeliveredNotification {
  actions: readonly NotificationActionDescriptor[];
  detail?: string;
  duration?: number;
  id: string;
  level: NotificationSeverity;
  message: string;
  observedAt: number;
  pendingActionId?: string;
  read: boolean;
  removable: boolean;
  title?: string;
  toast: "dismiss" | "never" | "present";
}

interface PresentationCopy {
  actions?: readonly NotificationActionDescriptor[];
  detail?: string;
  message: string;
  title?: string;
  toast?: DeliveredNotification["toast"];
}

export function presentNotification(
  record: NotificationRecordDto,
  LL: TranslationFunctions,
): DeliveredNotification {
  const parsedType = KnownNotificationTypeSchema.safeParse(record.type);
  const copy = parsedType.success
    ? knownPresentation(parsedType.data, record, LL)
    : {
        message: LL.notifications.unknownMessage(),
        title: LL.notifications.unknownTitle(),
      };
  return {
    actions: record.resolved ? [] : (copy.actions ?? []),
    detail: copy.detail,
    duration: record.pinned ? Number.POSITIVE_INFINITY : undefined,
    id: record.id,
    level: record.severity,
    message: copy.message,
    observedAt: record.observedAt,
    read: record.read,
    removable: !record.pinned,
    title: copy.title,
    toast: record.resolved ? "dismiss" : (copy.toast ?? "present"),
  };
}

function knownPresentation(
  type: ReturnType<typeof KnownNotificationTypeSchema.parse>,
  record: NotificationRecordDto,
  LL: TranslationFunctions,
): PresentationCopy {
  const string = (key: string) => {
    const value = record.params[key];
    return typeof value === "string" ? value : undefined;
  };
  const number = (key: string) => {
    const value = record.params[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const boolean = (key: string) => record.params[key] === true;
  switch (type) {
    case "capture.failure":
      return captureFailurePresentation(string("failure"), record.resolved, LL);
    case "local-proxy.feedback":
      return { message: localProxyFeedback(string("outcome"), LL) };
    case "onboarding.welcome":
      return {
        actions: [{ id: "open-welcome", label: LL.onboarding.notificationAction() }],
        message: LL.onboarding.notificationMessage(),
        title: LL.onboarding.promptTitle(),
        toast: boolean("prompt") ? "present" : "never",
      };
    case "profile.activation-failed":
      return { message: LL.profiles.activationFailed() };
    case "profile.activation-geodata-failed": {
      const asset = geodataAssetName(string("asset"));
      return {
        detail: LL.profiles.geodataRetry(),
        message:
          string("outcome") === "timeout"
            ? LL.profiles.geodataTimeout({ asset })
            : LL.profiles.geodataFailed({ asset }),
      };
    }
    case "profile.activation-geodata-progress":
      return {
        detail: LL.profiles.geodataPreparingDetail(),
        message: record.resolved
          ? LL.profiles.geodataPrepared({ asset: geodataAssetName(string("asset")) })
          : LL.profiles.geodataPreparing({ asset: geodataAssetName(string("asset")) }),
      };
    case "profile.activation-listener-conflict":
      return {
        actions: [
          { id: "find-ports-and-retry", label: LL.settingsPage.managedPortsFindAndRetry() },
        ],
        message: LL.settingsPage.managedPortsConflict({ endpoint: string("endpoint") ?? "—" }),
      };
    case "profile.create-failed":
      return { message: LL.profiles.createFailed() };
    case "profile.created":
      return { message: LL.profiles.createdToast() };
    case "profile.detach-failed":
      return { message: LL.profiles.detachSubscriptionFailed() };
    case "profile.detached":
      return { message: LL.profiles.subscriptionDetached() };
    case "profile.file-action-failed":
      return { message: LL.profiles.fileActionFailed() };
    case "profile.import-failed":
      return { message: LL.profiles.importFailed() };
    case "profile.patch-load-failed":
      return { message: LL.profiles.patchLoadFailed() };
    case "profile.patch-save-failed":
      return { message: LL.profiles.patchSaveFailed() };
    case "profile.patch-saved":
      return { message: LL.profiles.patchSaved() };
    case "profile.refresh-failed":
      return { message: LL.profiles.refreshFailed() };
    case "profile.save-failed":
      return { message: LL.profiles.saveFailed() };
    case "profile.saved":
      return { message: LL.profiles.savedToast() };
    case "profile.schedule-failed":
      return { message: LL.profiles.scheduleFailed() };
    case "profile.subscription-updated":
      return { message: LL.profiles.subscriptionUpdated() };
    case "profile.switch-failed":
      return { message: LL.profiles.switchFailed() };
    case "route.selection-failed":
      return {
        message: LL.routes.selectionFailed({ child: string("child") ?? "—" }),
        title: LL.routes.selectionFailedTitle(),
      };
    case "service.defaults-restored":
      return { message: LL.services.defaultRestoredToast() };
    case "service.removed":
      return { message: LL.services.removedToast() };
    case "service.saved":
      return {
        message:
          string("operation") === "updated" ? LL.services.updatedToast() : LL.services.addedToast(),
      };
    case "settings.operation-failed":
      return { message: LL.settingsPage.updateFailed() };
    case "status.operation-failed":
      return {
        actions: [openDiagnosticsAction(LL)],
        message: LL.errors.command(),
      };
    case "system-proxy.drift":
      return {
        actions: [
          ...(boolean("canRepair")
            ? [{ id: "repair", label: LL.capture.repairSystemProxy() }]
            : []),
          ...(boolean("canLeave")
            ? [
                {
                  id: "leave-as-is",
                  label: LL.capture.leaveAsIs(),
                  tone: "secondary" as const,
                },
              ]
            : []),
        ],
        message:
          string("failure") === "invalid-recovery"
            ? LL.capture.systemProxyInvalidRecovery()
            : boolean("repairRequiresCore")
              ? LL.capture.systemProxyRepairRequiresCore()
              : LL.capture.systemProxyDrift(),
      };
    case "system-proxy.failed":
      return {
        actions: [openDiagnosticsAction(LL)],
        message: systemProxyFailure(string("failure"), LL),
      };
    case "traffic.connection-closed":
      return { message: LL.traffic.closeConnectionSucceeded() };
    case "traffic.connections-closed":
      return { message: LL.traffic.closeAllActiveSucceeded({ count: number("count") ?? 0 }) };
    case "traffic.operation-failed":
      return { message: trafficFailureMessage(LL, trafficFailure(string("failure"))) };
    case "tun.drift":
      return { message: LL.capture.tunDrift() };
    case "tun.failed":
      return {
        actions: [openDiagnosticsAction(LL)],
        message: LL.capture.tunFailure(),
      };
  }
}

function captureFailurePresentation(
  failure: string | undefined,
  resolved: boolean,
  LL: TranslationFunctions,
): PresentationCopy {
  if (resolved) return { message: LL.capture.systemProxyApplied(), toast: "dismiss" };
  const actions = [openDiagnosticsAction(LL)];
  if (failure === "invalid-recovery") {
    return { actions, message: LL.capture.systemProxyInvalidRecovery() };
  }
  if (failure === "persistence-failed") {
    return { actions, message: LL.capture.systemProxyPersistenceFailure() };
  }
  if (failure === "core-unhealthy") {
    return { actions, message: LL.capture.systemProxyCoreFailure() };
  }
  if (failure === "external-drift") {
    return {
      actions: [
        { id: "repair", label: LL.capture.repairSystemProxy() },
        { id: "leave-as-is", label: LL.capture.leaveAsIs(), tone: "secondary" },
      ],
      message: LL.capture.systemProxyDrift(),
    };
  }
  return { actions, message: LL.capture.systemProxyFailure() };
}

function openDiagnosticsAction(LL: TranslationFunctions): NotificationActionDescriptor {
  return { id: "open-diagnostics", label: LL.diagnostics.open() };
}

function systemProxyFailure(failure: string | undefined, LL: TranslationFunctions) {
  if (failure === "permission-denied") return LL.capture.systemProxyPermissionFailure();
  if (failure === "core-unhealthy") return LL.capture.systemProxyCoreFailure();
  if (failure === "invalid-recovery") return LL.capture.systemProxyInvalidRecovery();
  if (failure === "persistence-failed") return LL.capture.systemProxyPersistenceFailure();
  return LL.capture.systemProxyFailure();
}

function localProxyFeedback(outcome: string | undefined, LL: TranslationFunctions) {
  if (outcome === "ready") return LL.settingsPage.localProxy.feedback.ready();
  if (outcome === "core-unhealthy") return LL.settingsPage.localProxy.feedback.coreUnhealthy();
  if (outcome === "runtime-transition") {
    return LL.settingsPage.localProxy.feedback.runtimeTransition();
  }
  if (outcome === "listener-unavailable") {
    return LL.settingsPage.localProxy.feedback.listenerUnavailable();
  }
  return LL.settingsPage.localProxy.feedback.rpcFailure();
}

function geodataAssetName(asset: string | undefined) {
  if (asset === "geo-site") return "GeoSite";
  if (asset === "geo-ip") return "GeoIP";
  if (asset === "mmdb") return "MMDB";
  if (asset === "asn") return "ASN";
  return "GeoSite/GeoIP/MMDB/ASN";
}

function trafficFailure(value: string | undefined) {
  if (
    value === "stale-connection" ||
    value === "stale-snapshot" ||
    value === "runtime-replaced" ||
    value === "controller-rejected" ||
    value === "partial-remaining" ||
    value === "timeout" ||
    value === "unsupported" ||
    value === "invalid-request" ||
    value === "conflict" ||
    value === "disconnected" ||
    value === "version-drift" ||
    value === "inconsistent-observation"
  ) {
    return value;
  }
  return null;
}
