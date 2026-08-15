import { TurboModuleRegistry } from "react-native";
import type { TurboModule } from "react-native";

export interface NativeCapabilitySnapshot {
  readonly fixture: "deterministic";
  readonly newArchitecture: true;
  readonly hermes: true;
  readonly vpnEffects: false;
  readonly tunEffects: false;
  readonly coreEffects: false;
  readonly networkEffects: false;
}

export interface RnAdmissionModule extends TurboModule {
  getCapabilities(): Promise<NativeCapabilitySnapshot>;
  smoke(): Promise<"native-capability-ok">;
}

/** The only native capability seam admitted by this fixture. */
export function getRnAdmissionModule(): RnAdmissionModule {
  return TurboModuleRegistry.getEnforcing<RnAdmissionModule>("MishRnAdmission");
}
