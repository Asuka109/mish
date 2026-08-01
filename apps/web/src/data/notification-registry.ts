import {
  type ApplicationActionId,
  type ApplicationNotification,
  type NotificationRecordDto,
  type NotificationSeverity,
} from "@mish/contracts";
import type { TranslationFunctions } from "../i18n/i18n-types";
import { trafficFailureMessage } from "./traffic-failure-message";

export type NotificationActionTone = "primary" | "secondary" | "destructive";

export interface NotificationActionDescriptor {
  id: ApplicationActionId;
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
  pendingActionId?: ApplicationActionId;
  read: boolean;
  removable: boolean;
  title?: string;
  toast: "dismiss" | "never" | "present";
}

interface PresentationCopy {
  detail?: string;
  message: string;
  title?: string;
  toast?: DeliveredNotification["toast"];
}

export function presentNotification(
  record: NotificationRecordDto,
  LL: TranslationFunctions,
): DeliveredNotification {
  const copy = knownPresentation(record.presentation, record.resolved, LL);
  return {
    actions: record.resolved
      ? []
      : record.presentation.actionIds.map((id) => actionDescriptor(id, LL)),
    detail: copy.detail,
    duration: record.pinned ? Number.POSITIVE_INFINITY : undefined,
    id: record.id,
    level: record.severity,
    message: copy.message,
    observedAt: record.observedAt,
    read: record.read,
    removable: !record.pinned,
    title: copy.title,
    toast: copy.toast ?? "present",
  };
}

function knownPresentation(
  presentation: ApplicationNotification,
  resolved: boolean,
  LL: TranslationFunctions,
): PresentationCopy {
  const { kind: type } = presentation;
  const data = presentation.data as Record<string, unknown>;
  const string = (key: string) => {
    const value = data[key];
    return typeof value === "string" ? value : undefined;
  };
  const number = (key: string) => {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const boolean = (key: string) => data[key] === true;
  switch (type) {
    case "capture.failure":
      return captureFailurePresentation(
        string("failure"),
        string("captureMode"),
        string("takeoverReason"),
        resolved,
        LL,
      );
    case "local-proxy.feedback":
      return { message: localProxyFeedback(string("outcome"), LL) };
    case "onboarding.welcome":
      return {
        message: LL.onboarding.notificationMessage(),
        title: LL.onboarding.promptTitle(),
        toast: boolean("prompt") ? "present" : "never",
      };
    case "profile.activation-failed":
      return {
        message: profileActivationFailure(string("failure"), LL),
      };
    case "profile.activation-asn-failed":
    case "profile.activation-geoip-failed":
    case "profile.activation-geosite-failed":
    case "profile.activation-mmdb-failed": {
      const asset = geodataAssetName(string("asset"));
      return {
        detail: LL.profiles.geodataRetry(),
        message:
          string("outcome") === "timeout"
            ? LL.profiles.geodataTimeout({ asset })
            : LL.profiles.geodataFailed({ asset }),
      };
    }
    case "profile.activation-asn-progress":
    case "profile.activation-geoip-progress":
    case "profile.activation-geosite-progress":
    case "profile.activation-mmdb-progress":
      return {
        detail: LL.profiles.geodataPreparingDetail(),
        message: resolved
          ? LL.profiles.geodataPrepared({ asset: geodataAssetName(string("asset")) })
          : LL.profiles.geodataPreparing({ asset: geodataAssetName(string("asset")) }),
        toast: resolved ? "dismiss" : undefined,
      };
    case "profile.activation-listener-conflict":
      return {
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
    case "route.old-child-cleanup": {
      const phase = string("phase");
      const failure = string("failure") ?? "unknown";
      const closed = number("closedCount") ?? 0;
      const target = number("targetCount") ?? 0;
      if (string("mode") === "off") {
        return { message: LL.routes.cleanupOff() };
      }
      if (phase === "completed") {
        return { message: LL.routes.cleanupCompleted({ closed, target }) };
      }
      if (phase === "partial") {
        return { message: LL.routes.cleanupPartial({ closed, failure, target }) };
      }
      if (phase === "failed") {
        return { message: LL.routes.cleanupFailed({ failure }) };
      }
      return { message: LL.routes.cleanupSkipped() };
    }
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
        message: LL.errors.command(),
      };
    case "system-proxy.drift":
      return {
        message:
          string("failure") === "invalid-recovery"
            ? LL.capture.systemProxyInvalidRecovery()
            : boolean("repairRequiresCore")
              ? LL.capture.systemProxyRepairRequiresCore()
              : LL.capture.systemProxyDrift(),
      };
    case "system-proxy.failed":
      return {
        message: systemProxyFailure(string("failure"), LL),
      };
    case "traffic.connection-closed":
      return { message: LL.traffic.closeConnectionSucceeded() };
    case "traffic.connections-closed":
      return { message: LL.traffic.closeAllActiveSucceeded({ count: number("count") ?? 0 }) };
    case "traffic.operation-failed":
      return { message: trafficFailureMessage(LL, trafficFailure(string("failure"))) };
    case "tun-helper.lifecycle": {
      const operation =
        string("operation") === "install"
          ? LL.settingsPage.installTunHelper()
          : string("operation") === "repair"
            ? LL.settingsPage.repairTunHelper()
            : LL.settingsPage.removeTunHelper();
      if (["pending", "finalizing"].includes(string("outcome") ?? "")) {
        return { message: LL.settingsPage.tunHelperLifecyclePending({ operation }) };
      }
      if (string("outcome") === "applied") {
        return { message: LL.settingsPage.tunHelperLifecycleApplied({ operation }) };
      }
      return {
        message: LL.settingsPage.tunHelperLifecycleFailed({
          failure: string("failure") ?? "unknown",
          operation,
        }),
      };
    }
    case "tun.drift":
      return { message: LL.capture.tunDrift() };
    case "tun.failed":
      return {
        message: LL.capture.tunFailure(),
      };
  }
}

function captureFailurePresentation(
  failure: string | undefined,
  captureMode: string | undefined,
  takeoverReason: string | undefined,
  resolved: boolean,
  LL: TranslationFunctions,
): PresentationCopy {
  if (resolved) return { message: LL.capture.systemProxyApplied(), toast: "dismiss" };
  if (failure === "configuration-required") {
    return {
      message: LL.capture.configurationRequired(),
      title: LL.capture.configurationRequiredTitle(),
    };
  }
  if (isTakeoverRejection(takeoverReason)) {
    return {
      message: LL.settingsPage.systemProxyTakeoverRejected(),
    };
  }
  if (failure === "invalid-recovery") {
    return { message: LL.capture.systemProxyInvalidRecovery() };
  }
  if (failure === "persistence-failed") {
    return { message: LL.capture.systemProxyPersistenceFailure() };
  }
  if (failure === "core-unhealthy") {
    return { message: LL.capture.systemProxyCoreFailure() };
  }
  if (failure === "external-drift") {
    if (captureMode === "tun") return { message: LL.capture.tunDrift() };
    return { message: LL.capture.systemProxyDrift() };
  }
  return { message: LL.capture.systemProxyFailure() };
}

function isTakeoverRejection(value: string | undefined) {
  return [
    "authenticated-proxy",
    "incomplete-observation",
    "invalid-state",
    "protected-auto-discovery",
    "protected-pac",
    "unrecoverable-state",
  ].includes(value ?? "");
}

function actionDescriptor(
  id: ApplicationActionId,
  LL: TranslationFunctions,
): NotificationActionDescriptor {
  switch (id) {
    case "find-ports-and-retry":
      return { id, label: LL.settingsPage.managedPortsFindAndRetry() };
    case "leave-as-is":
      return { id, label: LL.capture.leaveAsIs(), tone: "secondary" };
    case "open-system-proxy-settings":
      return openSystemProxySettingsAction(LL);
    case "open-profiles":
      return { id, label: LL.capture.openProfiles() };
    case "open-welcome":
      return { id, label: LL.onboarding.notificationAction() };
    case "repair":
      return { id, label: LL.capture.repairSystemProxy() };
    case "retry-profile-activation":
      return { id, label: LL.profiles.retryActivation() };
    case "show-system-proxy-settings-steps":
      return {
        id,
        label: LL.capture.showSystemProxySettingsSteps(),
        tone: "secondary",
      };
  }
}

function openSystemProxySettingsAction(LL: TranslationFunctions): NotificationActionDescriptor {
  return { id: "open-system-proxy-settings", label: LL.capture.reviewSystemProxySettings() };
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

function profileActivationFailure(failure: string | undefined, LL: TranslationFunctions) {
  const copy = LL.profiles.activationFailureNotification;
  switch (failure) {
    case "invalid-profile":
      return copy.invalidProfile();
    case "missing-binary":
      return copy.missingBinary();
    case "unsafe-runtime":
      return copy.unsafeRuntime();
    case "staging":
      return copy.staging();
    case "validation":
      return copy.validation();
    case "geodata-failed":
      return copy.geodataFailed();
    case "geodata-timeout":
      return copy.geodataTimeout();
    case "start":
      return copy.start();
    case "tun-helper-unavailable":
      return copy.tunHelperUnavailable();
    case "tun-network-ownership-conflict":
      return copy.tunNetworkOwnershipConflict();
    case "early-exit":
      return copy.earlyExit();
    case "managed-listener-conflict":
      return copy.managedListenerConflict();
    case "version-mismatch":
      return copy.versionMismatch();
    case "controller":
      return copy.controller();
    case "timeout":
      return copy.timeout();
    case "cancelled":
      return copy.cancelled();
    case "capture":
      return copy.capture();
    case "prior-stop":
      return copy.priorStop();
    case "state-commit":
      return copy.stateCommit();
    default:
      return LL.profiles.activationFailed();
  }
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
