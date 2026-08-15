import { TurboModuleRegistry } from "react-native";
import type { TurboModule } from "react-native";

/**
 * Facts exposed by the only native seam in the RN admission host. These are
 * fixed capability facts, not product lifecycle or remote-cache state.
 */
export interface NativeCapabilitySnapshot {
  readonly fixture: "deterministic";
  readonly newArchitecture: true;
  readonly hermes: true;
  readonly vpnEffects: false;
  readonly tunEffects: false;
  readonly coreEffects: false;
  readonly networkEffects: false;
}

export interface RnHostModule extends TurboModule {
  getCapabilities(): Promise<NativeCapabilitySnapshot>;
  smoke(): Promise<"native-capability-ok">;
}

/** Resolve the narrow native capability adapter; it owns no product state. */
export function getRnHostModule(): RnHostModule {
  return TurboModuleRegistry.getEnforcing<RnHostModule>("MishRnHost");
}
