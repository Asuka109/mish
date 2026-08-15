import { TurboModule, TurboModuleRegistry } from "react-native";

/** Codegen specification for the closed Android capability boundary. */
export interface Spec extends TurboModule {
  getSnapshot(): Promise<string>;
  requestCapability(capability: string, requestId: string): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>("MishCapability");
