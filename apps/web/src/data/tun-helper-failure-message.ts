import type { TunHelperFailureKind } from "@mish/contracts";
import type { TranslationFunctions } from "../i18n/i18n-types";

export function tunHelperFailureMessage(
  LL: TranslationFunctions,
  failure: TunHelperFailureKind | null,
) {
  switch (failure) {
    case "authorization-cancelled":
      return LL.capture.tunGuide.authorizationCancelled();
    case "confirmation-failed":
      return LL.capture.tunGuide.confirmationFailed();
    case "installation-failed":
      return LL.capture.tunGuide.installationFailed();
    case "installer-unavailable":
      return LL.capture.tunGuide.installerUnavailable();
    case "preparation-failed":
      return LL.capture.tunGuide.preparationFailed();
    default:
      return LL.capture.tunGuide.installFailed();
  }
}
