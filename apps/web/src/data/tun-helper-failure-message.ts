import type { TunHelperFailureKind } from "@mish/contracts";
import type { TranslationFunctions } from "../i18n/i18n-types";

export const tunHelperLifecycleOperations = ["install", "repair", "remove"] as const;

export type TunHelperLifecycleOperation = (typeof tunHelperLifecycleOperations)[number];

interface TunHelperFailureMessageArgs {
  operation: string;
  recovery: string;
  retry: string;
}

type TunHelperFailureCategory =
  | "authorization-cancelled"
  | "authorization-failed"
  | "confirmation-failed"
  | "connection-failed"
  | "installation-failed"
  | "installer-unavailable"
  | "invalid-response"
  | "observation-failed"
  | "operation-failed"
  | "preparation-failed"
  | "registration-failed"
  | "registration-requires-approval"
  | "repair-required"
  | "unsupported-build"
  | "unsigned-app"
  | "unsupported-system";

const tunHelperFailureCategories = {
  "authorization-cancelled": "authorization-cancelled",
  "confirmation-failed": "confirmation-failed",
  "connection-failed": "connection-failed",
  "identity-rejected": "repair-required",
  "installation-failed": "installation-failed",
  "installer-unavailable": "installer-unavailable",
  "invalid-signature": "repair-required",
  "message-too-large": "invalid-response",
  "observation-foreign": "observation-failed",
  "observation-partial": "observation-failed",
  "observation-stale": "observation-failed",
  "operation-failed": "operation-failed",
  "permission-denied": "authorization-failed",
  "preparation-failed": "preparation-failed",
  "protocol-mismatch": "repair-required",
  "registration-failed": "registration-failed",
  "registration-requires-approval": "registration-requires-approval",
  unpackaged: "unsupported-build",
  "unsigned-app": "unsigned-app",
  "unsupported-system": "unsupported-system",
  "version-mismatch": "repair-required",
} as const satisfies Record<TunHelperFailureKind, TunHelperFailureCategory>;

export function tunHelperLifecycleOperation(
  value: string | undefined,
): TunHelperLifecycleOperation | null {
  if (value === "install" || value === "repair" || value === "remove") return value;
  return null;
}

export function tunHelperOperationName(
  LL: TranslationFunctions,
  operation: TunHelperLifecycleOperation,
) {
  if (operation === "install") return LL.settingsPage.installTunHelper();
  if (operation === "repair") return LL.settingsPage.repairTunHelper();
  return LL.settingsPage.removeTunHelper();
}

export function tunHelperLifecycleFailureMessage(
  LL: TranslationFunctions,
  operation: TunHelperLifecycleOperation,
  failure: TunHelperFailureKind | null,
) {
  const copy = LL.settingsPage.tunHelperLifecycleFailure;
  const args = tunHelperFailureMessageArgs(LL, operation);
  const category = failure ? tunHelperFailureCategories[failure] : "operation-failed";
  switch (category) {
    case "authorization-cancelled":
      return copy.authorizationCancelled(args);
    case "authorization-failed":
      return copy.authorizationFailed(args);
    case "confirmation-failed":
      return copy.confirmationFailed(args);
    case "connection-failed":
      return copy.connectionFailed(args);
    case "installation-failed":
      return copy.installationFailed(args);
    case "installer-unavailable":
      return copy.installerUnavailable(args);
    case "invalid-response":
      return copy.invalidResponse(args);
    case "observation-failed":
      return copy.observationFailed(args);
    case "operation-failed":
      return copy.operationFailed(args);
    case "preparation-failed":
      return copy.preparationFailed(args);
    case "registration-failed":
      return copy.registrationFailed(args);
    case "registration-requires-approval":
      return copy.registrationRequiresApproval(args);
    case "repair-required":
      return copy.repairRequired(args);
    case "unsupported-build":
      return copy.unsupportedBuild(args);
    case "unsigned-app":
      return copy.unsignedApp(args);
    case "unsupported-system":
      return copy.unsupportedSystem(args);
  }
}

function tunHelperFailureMessageArgs(
  LL: TranslationFunctions,
  operation: TunHelperLifecycleOperation,
): TunHelperFailureMessageArgs {
  return {
    operation: tunHelperOperationName(LL, operation),
    recovery:
      operation === "remove"
        ? LL.settingsPage.tunHelperLifecycleRemoveRecovery()
        : LL.settingsPage.tunHelperLifecycleReinstallRecovery(),
    retry: tunHelperRetryAction(LL, operation),
  };
}

function tunHelperRetryAction(LL: TranslationFunctions, operation: TunHelperLifecycleOperation) {
  if (operation === "install") return LL.settingsPage.tunHelperLifecycleRetryInstall();
  if (operation === "repair") return LL.settingsPage.tunHelperLifecycleRetryRepair();
  return LL.settingsPage.tunHelperLifecycleRetryRemove();
}
