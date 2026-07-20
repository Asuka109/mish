import type { TrafficCommandFailure } from "@mish/contracts";
import type { TranslationFunctions } from "../i18n/i18n-types";

export function trafficFailureMessage(
  LL: TranslationFunctions,
  failure: TrafficCommandFailure | null,
) {
  if (failure === "stale-connection") return LL.traffic.closeStaleConnection();
  if (failure === "stale-snapshot") return LL.traffic.closeStaleSnapshot();
  if (failure === "runtime-replaced") return LL.traffic.closeRuntimeReplaced();
  if (failure === "controller-rejected") return LL.traffic.closeControllerRejected();
  if (failure === "partial-remaining") return LL.traffic.closePartialRemaining();
  if (failure === "timeout") return LL.traffic.closeTimeout();
  if (failure === "unsupported" || failure === "invalid-request") {
    return LL.traffic.closeUnsupported();
  }
  if (failure === "conflict") return LL.traffic.closeConflict();
  return LL.traffic.closeFailed();
}
