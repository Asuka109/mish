import type { MobilePlatformKind, MobileVpnPhase } from "@mish/contracts";
import NativeMishCapability, { type Spec } from "./NativeMishCapability";

export const CAPABILITY_CONTRACT_VERSION = 1 as const;
export const CAPABILITY_NAMES = [
  "vpn",
  "tun",
  "core",
  "socket-protection",
  "foreground-service",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type FoundationPlatform = Extract<MobilePlatformKind, "android">;
export type FoundationUnavailablePhase = Extract<MobileVpnPhase, "unavailable">;

export type CapabilitySnapshot = {
  contractVersion: typeof CAPABILITY_CONTRACT_VERSION;
  state: "unavailable";
  capabilities: CapabilityName[];
  message: string;
};

export type CapabilityResult = {
  contractVersion: typeof CAPABILITY_CONTRACT_VERSION;
  capability: CapabilityName;
  requestId: string;
  state: "unavailable";
  reason: "not-implemented";
  message: string;
};

type InvalidResult = {
  contractVersion: typeof CAPABILITY_CONTRACT_VERSION;
  capability: null;
  requestId: null;
  state: "rejected";
  reason: "invalid-input" | "malformed-native-response";
  message: string;
};

export type CapabilityResponse = CapabilityResult | InvalidResult;
export type NativeCapabilityModule = Pick<Spec, "getSnapshot" | "requestCapability">;

const MAX_NATIVE_RESPONSE_BYTES = 4_096;
const MAX_REQUEST_ID_LENGTH = 64;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const UNAVAILABLE_MESSAGE = "Native platform effects are unavailable in this foundation build.";

const fallbackSnapshot: CapabilitySnapshot = {
  contractVersion: CAPABILITY_CONTRACT_VERSION,
  state: "unavailable",
  capabilities: [...CAPABILITY_NAMES],
  message: UNAVAILABLE_MESSAGE,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

function isCapabilityName(value: unknown): value is CapabilityName {
  return typeof value === "string" && (CAPABILITY_NAMES as readonly string[]).includes(value);
}

function parseBoundedJson(serialized: string): unknown {
  if (serialized.length > MAX_NATIVE_RESPONSE_BYTES) {
    throw new Error("native-response-too-large");
  }
  return JSON.parse(serialized) as unknown;
}

export function parseCapabilitySnapshot(serialized: string): CapabilitySnapshot {
  const value = parseBoundedJson(serialized);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["capabilities", "contractVersion", "message", "state"]) ||
    value.contractVersion !== CAPABILITY_CONTRACT_VERSION ||
    value.state !== "unavailable" ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 512 ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length !== CAPABILITY_NAMES.length ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    value.capabilities.some((capability) => !isCapabilityName(capability))
  ) {
    throw new Error("malformed-native-response");
  }
  return {
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    state: "unavailable",
    capabilities: [...value.capabilities] as CapabilityName[],
    message: value.message,
  };
}

export function parseCapabilityResult(serialized: string): CapabilityResult {
  const value = parseBoundedJson(serialized);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "capability",
      "contractVersion",
      "message",
      "reason",
      "requestId",
      "state",
    ]) ||
    value.contractVersion !== CAPABILITY_CONTRACT_VERSION ||
    !isCapabilityName(value.capability) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    value.state !== "unavailable" ||
    value.reason !== "not-implemented" ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 512
  ) {
    throw new Error("malformed-native-response");
  }
  return {
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    capability: value.capability,
    requestId: value.requestId,
    state: "unavailable",
    reason: "not-implemented",
    message: value.message,
  };
}

function invalidResult(reason: InvalidResult["reason"]): InvalidResult {
  return {
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    capability: null,
    requestId: null,
    state: "rejected",
    reason,
    message:
      reason === "invalid-input"
        ? "Capability name or request identity is invalid."
        : "The native capability response was malformed.",
  };
}

function unavailableResult(capability: CapabilityName, requestId: string): CapabilityResult {
  return {
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    capability,
    requestId,
    state: "unavailable",
    reason: "not-implemented",
    message: UNAVAILABLE_MESSAGE,
  };
}

export function createCapabilityClient(
  nativeModule: NativeCapabilityModule | null = NativeMishCapability ?? null,
) {
  return {
    async getSnapshot(): Promise<CapabilitySnapshot> {
      if (nativeModule === null) return fallbackSnapshot;
      try {
        return parseCapabilitySnapshot(await nativeModule.getSnapshot());
      } catch {
        return fallbackSnapshot;
      }
    },
    async requestCapability(
      capability: CapabilityName,
      requestId: string,
    ): Promise<CapabilityResponse> {
      if (
        !isCapabilityName(capability) ||
        requestId.length > MAX_REQUEST_ID_LENGTH ||
        !REQUEST_ID_PATTERN.test(requestId)
      ) {
        return invalidResult("invalid-input");
      }
      if (nativeModule === null) return unavailableResult(capability, requestId);
      try {
        return parseCapabilityResult(await nativeModule.requestCapability(capability, requestId));
      } catch {
        return invalidResult("malformed-native-response");
      }
    },
  };
}

export const capabilityClient = createCapabilityClient();
