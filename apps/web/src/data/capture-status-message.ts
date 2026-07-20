import type { SystemProxyRuntimeStatusDto, TunRuntimeStatusDto } from "@mish/contracts";
import type { TranslationFunctions } from "../i18n/i18n-types";

export function systemProxyStatusMessage(
  LL: TranslationFunctions,
  status: SystemProxyRuntimeStatusDto,
  pending = false,
) {
  if (status.phase === "drift") {
    if (status.failure === "invalid-recovery") {
      return LL.capture.systemProxyInvalidRecovery();
    }
    if (status.failure === "persistence-failed") {
      return LL.capture.systemProxyPersistenceFailure();
    }
    return LL.capture.systemProxyDrift();
  }
  if (status.phase === "failed") {
    if (status.failure === "permission-denied") {
      return LL.capture.systemProxyPermissionFailure();
    }
    if (status.failure === "unsafe-existing-configuration") {
      return LL.capture.systemProxyUnsafeFailure();
    }
    if (status.failure === "core-unhealthy") {
      return LL.capture.systemProxyCoreFailure();
    }
    if (status.failure === "invalid-recovery") {
      return LL.capture.systemProxyInvalidRecovery();
    }
    if (status.failure === "persistence-failed") {
      return LL.capture.systemProxyPersistenceFailure();
    }
    return LL.capture.systemProxyFailure();
  }
  if (pending || status.phase === "pending") return LL.capture.systemProxyPending();
  if (status.phase === "applied") return LL.capture.systemProxyApplied();
  if (status.observed === "other" || status.observed === "mish") {
    return LL.capture.systemProxyLeftAsIs();
  }
  if (status.observed === "unknown") return LL.capture.systemProxyUnknown();
  return LL.capture.systemProxyOff();
}

export function tunStatusMessage(
  LL: TranslationFunctions,
  status: TunRuntimeStatusDto,
  pending = false,
) {
  if (status.phase === "drift") return LL.capture.tunDrift();
  if (status.phase === "failed") return LL.capture.tunFailure();
  if (pending || status.phase === "pending") return LL.capture.tunPending();
  if (status.phase === "applied") return LL.capture.tunApplied();
  return LL.capture.tunOff();
}
