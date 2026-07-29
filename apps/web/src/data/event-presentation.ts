import type { ApplicationActionId, EventRecordDto } from "@mish/contracts";
import type { TranslationFunctions } from "../i18n/i18n-types";
import { trafficFailureMessage } from "./traffic-failure-message";

export interface PresentedEventRecord extends Omit<EventRecordDto, "application" | "evidence"> {
  actionIds: readonly ApplicationActionId[];
  detail: string | null;
  message: string;
}

export function presentEvent(
  event: EventRecordDto,
  LL: TranslationFunctions,
): PresentedEventRecord {
  const { application, evidence, ...identity } = event;
  if (evidence) {
    return {
      ...identity,
      actionIds: [],
      detail: evidence.detail,
      message: evidence.message,
    };
  }
  if (!application) {
    throw new Error("Validated event is missing presentation content");
  }
  const data = application.data as Record<string, unknown>;
  const string = (key: string) => {
    const value = data[key];
    return typeof value === "string" ? value : undefined;
  };
  const number = (key: string) => {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const copy = applicationEventCopy(application.kind, string, number, LL);
  return {
    ...identity,
    actionIds: application.actionIds,
    detail: copy.detail,
    message: copy.message,
  };
}

function applicationEventCopy(
  kind: NonNullable<EventRecordDto["application"]>["kind"],
  string: (key: string) => string | undefined,
  number: (key: string) => number,
  LL: TranslationFunctions,
): { detail: string | null; message: string } {
  switch (kind) {
    case "capture.failure":
      return {
        detail: LL.events.application.captureFailureDetail(),
        message: captureFailureMessage(string("failure"), LL),
      };
    case "controller.session-started":
      return {
        detail: LL.events.application.controllerSessionStartedDetail(),
        message: LL.events.application.controllerSessionStarted(),
      };
    case "controller.session-stale":
      return {
        detail: LL.events.application.controllerSessionStaleDetail(),
        message: LL.events.application.controllerSessionStale(),
      };
    case "controller.stream-unavailable":
      return {
        detail: LL.events.application.controllerStreamUnavailableDetail({
          failure: string("failure") ?? "unavailable",
        }),
        message: LL.events.application.controllerStreamUnavailable(),
      };
    case "profile.activation-failed":
      return {
        detail: LL.events.application.profileActivationFailedDetail({
          failure: string("failure") ?? "unknown",
        }),
        message: LL.profiles.activationFailed(),
      };
    case "proxy.launch-timing":
      return {
        detail: LL.events.application.proxyLaunchTimingDetail({
          outcome: string("outcome") ?? "unknown",
          total: number("totalMs"),
        }),
        message: LL.events.application.proxyLaunchTiming(),
      };
    case "route.old-child-cleanup":
      return {
        detail: `${LL.events.application.routeOldChildCleanupDetail({
          closed: number("closedCount"),
          failed: number("failedCount"),
          failure: string("failure") ?? "none",
          mode: string("mode") ?? "unknown",
          phase: string("phase") ?? "unknown",
          target: number("targetCount"),
        })} ${LL.events.application.routeOldChildCleanupRevisionDetail({
          catalog: string("catalogRevision") ?? "unknown",
          membership: string("membershipRevision") ?? "unknown",
          session: number("controllerSessionRevision"),
        })}`,
        message: LL.events.application.routeOldChildCleanup(),
      };
    case "settings.operation-failed":
      return {
        detail: LL.events.application.settingsOperationFailedDetail(),
        message: LL.settingsPage.updateFailed(),
      };
    case "traffic.operation-failed":
      return {
        detail: LL.events.application.trafficOperationFailedDetail(),
        message: trafficFailureMessage(LL, trafficFailure(string("failure"))),
      };
  }
}

function captureFailureMessage(failure: string | undefined, LL: TranslationFunctions) {
  if (failure === "configuration-required") return LL.capture.configurationRequired();
  if (failure === "permission-denied") return LL.capture.systemProxyPermissionFailure();
  if (failure === "core-unhealthy") return LL.capture.systemProxyCoreFailure();
  if (failure === "invalid-recovery") return LL.capture.systemProxyInvalidRecovery();
  if (failure === "persistence-failed") return LL.capture.systemProxyPersistenceFailure();
  if (failure === "external-drift") return LL.capture.systemProxyDrift();
  return LL.capture.systemProxyFailure();
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
