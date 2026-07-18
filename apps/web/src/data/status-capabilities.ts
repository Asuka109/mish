import type { CapabilityAvailability, StatusAdapterKind, StatusSnapshotDto } from "@mish/contracts";

export const statusDescriptionIds = {
  capturePermission: "capture-permission-description",
  captureUnavailable: "capture-unavailable-description",
  fixtureAction: "fixture-action-description",
  localActionUnavailable: "local-action-unavailable-description",
  systemProxyPermission: "system-proxy-permission-description",
  systemProxyUnavailable: "system-proxy-unavailable-description",
  tunPermission: "tun-permission-description",
  tunUnavailable: "tun-unavailable-description",
} as const;

export function isCaptureCapabilityAvailable(
  adapterKind: StatusAdapterKind,
  availability: CapabilityAvailability,
) {
  if (adapterKind === "fixture") return availability === "fixture-only";
  return availability === "supported";
}

export function getCommandDescriptionId(adapterKind: StatusAdapterKind, commandSupported: boolean) {
  if (adapterKind === "fixture") return statusDescriptionIds.fixtureAction;
  if (!commandSupported) return statusDescriptionIds.localActionUnavailable;
  return undefined;
}

export function getCaptureModeDescriptionId(
  adapterKind: StatusAdapterKind,
  availability: CapabilityAvailability,
  commandSupported: boolean,
  mode: "systemProxy" | "tun",
) {
  if (adapterKind === "fixture") return statusDescriptionIds.fixtureAction;
  if (availability === "permission-required") {
    return mode === "systemProxy"
      ? statusDescriptionIds.systemProxyPermission
      : statusDescriptionIds.tunPermission;
  }
  if (!isCaptureCapabilityAvailable(adapterKind, availability)) {
    return mode === "systemProxy"
      ? statusDescriptionIds.systemProxyUnavailable
      : statusDescriptionIds.tunUnavailable;
  }
  if (!commandSupported) return statusDescriptionIds.localActionUnavailable;
  return undefined;
}

export function getAggregateCaptureDescriptionId(
  snapshot: StatusSnapshotDto,
  commandSupported: boolean,
) {
  if (snapshot.adapterKind === "fixture") return statusDescriptionIds.fixtureAction;

  const availabilities = [snapshot.capabilities.systemProxy, snapshot.capabilities.tun];
  if (availabilities.includes("permission-required")) {
    return statusDescriptionIds.capturePermission;
  }
  if (
    !availabilities.some((availability) =>
      isCaptureCapabilityAvailable(snapshot.adapterKind, availability),
    )
  ) {
    return statusDescriptionIds.captureUnavailable;
  }
  if (!commandSupported) return statusDescriptionIds.localActionUnavailable;
  return undefined;
}
