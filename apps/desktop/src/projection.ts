import {
  ORPC_OPERATIONS,
  type OrpcEventData,
  type OrpcOperation,
  type OrpcOperationData,
  type OrpcProfileData,
  type OrpcRouteData,
  type OrpcSettingsData,
  type OrpcStatusData,
  type OrpcTrafficData,
} from "@mish/contracts";

import {
  electronProjectionOperation,
  type ElectronProjectionTranscriptOperation,
} from "./transcript.js";

const CORRELATION_PATTERN = /^orpc-correlation-([0-9]{4,})$/u;
const MAX_CORRELATION = 9_999;
const MAX_TEXT_BYTES = 16 * 1024;

export type ElectronProjectionErrorCode =
  | "CLIENT_CLOSED_REQUEST"
  | "CONFLICT"
  | "DISPOSED"
  | "FORBIDDEN"
  | "PAYLOAD_TOO_LARGE"
  | "TIMEOUT";

export class ElectronProjectionError extends Error {
  readonly code: ElectronProjectionErrorCode;
  readonly status: 400 | 403 | 408 | 409 | 410 | 413 | 499;

  constructor(code: ElectronProjectionErrorCode, status: 400 | 403 | 408 | 409 | 410 | 413 | 499) {
    super(code);
    this.name = "ElectronProjectionError";
    this.code = code;
    this.status = status;
  }
}

export interface ElectronProjectionSession {
  readonly generation: number;
  readonly parentEpoch: number;
  readonly revision: number;
}

export interface ElectronProjectionRequest {
  readonly correlationId: unknown;
  readonly deadlineMs: unknown;
  readonly operation: unknown;
  readonly parentEpoch: unknown;
  readonly revision: unknown;
  readonly sessionGeneration: unknown;
}

export type ElectronProjectionAvailability = "degraded" | "ready" | "unavailable";

export interface ElectronOwnedSettings {
  readonly appearance: OrpcSettingsData["appearance"];
  readonly language: OrpcSettingsData["language"];
}

export type ElectronProjectionDataByOperation = {
  "status.snapshot": OrpcStatusData;
  "routes.snapshot": OrpcRouteData;
  "profile.refresh": OrpcProfileData;
  "traffic.snapshot": OrpcTrafficData;
  "events.snapshot": OrpcEventData;
  "settings.snapshot": OrpcSettingsData;
};

export type ElectronProjectionResultKind =
  | "projection-degraded"
  | "projection-empty"
  | "projection-owned"
  | "projection-ready"
  | "projection-unavailable";

export type ElectronProjectionResult = {
  [TOperation in OrpcOperation]: {
    readonly data: ElectronProjectionDataByOperation[TOperation];
    readonly operation: TOperation;
    readonly result: ElectronProjectionResultKind;
    readonly transcriptOperation: ElectronProjectionTranscriptOperation;
  };
}[OrpcOperation];

export interface ElectronProjectionAuthority {
  readonly availability: ElectronProjectionAvailability;
  readonly available: boolean;
  readonly disposed: boolean;
  readonly session: ElectronProjectionSession;
  setAvailable(): void;
  setSession(session: ElectronProjectionSession): void;
  setRuntimeObservation(observation: "ready"): void;
  invoke(request: ElectronProjectionRequest, signal?: AbortSignal): ElectronProjectionResult;
  dispose(): void;
}

const DEFAULT_OWNED_SETTINGS: ElectronOwnedSettings = Object.freeze({
  appearance: "system",
  language: "en",
});

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOperation(value: unknown): value is OrpcOperation {
  return typeof value === "string" && ORPC_OPERATIONS.includes(value as OrpcOperation);
}

function assertCorrelation(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new ElectronProjectionError("FORBIDDEN", 403);
  const match = CORRELATION_PATTERN.exec(value);
  const number = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!match || !Number.isSafeInteger(number) || number < 1 || number > MAX_CORRELATION) {
    throw new ElectronProjectionError("FORBIDDEN", 403);
  }
}

function assertSessionValue(value: unknown, expected: number): void {
  if (!isPositiveInteger(value) || value !== expected) {
    throw new ElectronProjectionError("CONFLICT", 409);
  }
}

function assertBoundedProjection(data: OrpcOperationData): void {
  const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
  if (bytes > MAX_TEXT_BYTES) {
    throw new ElectronProjectionError("PAYLOAD_TOO_LARGE", 413);
  }
}

function emptyRoutes(): OrpcRouteData {
  return { kind: "routes", groups: [] };
}

function emptyProfiles(): OrpcProfileData {
  return { kind: "profiles", profiles: [] };
}

function emptyTraffic(): OrpcTrafficData {
  return { kind: "traffic", connections: [], rules: [] };
}

function emptyEvents(): OrpcEventData {
  return { kind: "events", events: [] };
}

function statusData(availability: ElectronProjectionAvailability): OrpcStatusData {
  return {
    activeConnections: 0,
    downloadBytesPerSecond: 0,
    kind: "status",
    phase: availability,
    profileName: null,
    uploadBytesPerSecond: 0,
  };
}

function settings(owned: ElectronOwnedSettings): OrpcSettingsData {
  return {
    appearance: owned.appearance,
    kind: "settings",
    language: owned.language,
    readOnly: true,
  };
}

function invokeResult(
  operation: OrpcOperation,
  availability: ElectronProjectionAvailability,
  ownedSettings: ElectronOwnedSettings,
): ElectronProjectionResult {
  switch (operation) {
    case "status.snapshot": {
      const data = statusData(availability);
      assertBoundedProjection(data);
      return {
        data,
        operation,
        result:
          availability === "ready"
            ? "projection-ready"
            : availability === "degraded"
              ? "projection-degraded"
              : "projection-unavailable",
        transcriptOperation: electronProjectionOperation(operation),
      };
    }
    case "routes.snapshot": {
      const data = emptyRoutes();
      assertBoundedProjection(data);
      return {
        data,
        operation,
        result: "projection-empty",
        transcriptOperation: electronProjectionOperation(operation),
      };
    }
    case "profile.refresh": {
      const data = emptyProfiles();
      assertBoundedProjection(data);
      return {
        data,
        operation,
        result: "projection-empty",
        transcriptOperation: electronProjectionOperation(operation),
      };
    }
    case "traffic.snapshot": {
      const data = emptyTraffic();
      assertBoundedProjection(data);
      return {
        data,
        operation,
        result: "projection-empty",
        transcriptOperation: electronProjectionOperation(operation),
      };
    }
    case "events.snapshot": {
      const data = emptyEvents();
      assertBoundedProjection(data);
      return {
        data,
        operation,
        result: "projection-empty",
        transcriptOperation: electronProjectionOperation(operation),
      };
    }
    case "settings.snapshot": {
      const data = settings(ownedSettings);
      assertBoundedProjection(data);
      return {
        data,
        operation,
        result: "projection-owned",
        transcriptOperation: electronProjectionOperation(operation),
      };
    }
  }
}

export function createElectronProjectionAuthority(
  options: {
    readonly settings?: ElectronOwnedSettings;
  } = {},
): ElectronProjectionAuthority {
  let availability: ElectronProjectionAvailability = "unavailable";
  let disposed = false;
  let session: ElectronProjectionSession = {
    generation: 0,
    parentEpoch: 0,
    revision: 0,
  };
  const ownedSettings = Object.freeze({ ...(options.settings ?? DEFAULT_OWNED_SETTINGS) });

  return {
    get available(): boolean {
      return availability !== "unavailable";
    },
    get availability(): ElectronProjectionAvailability {
      return availability;
    },
    get disposed(): boolean {
      return disposed;
    },
    get session(): ElectronProjectionSession {
      return session;
    },
    setAvailable(): void {
      if (disposed) throw new ElectronProjectionError("DISPOSED", 410);
      availability = "degraded";
    },
    setSession(next: ElectronProjectionSession): void {
      if (disposed) throw new ElectronProjectionError("DISPOSED", 410);
      if (
        !isPositiveInteger(next.generation) ||
        !isPositiveInteger(next.parentEpoch) ||
        !isPositiveInteger(next.revision)
      ) {
        throw new ElectronProjectionError("CONFLICT", 409);
      }
      session = { ...next };
      availability = "unavailable";
    },
    // The current host has no Runtime/Core observation and never calls this.
    // A future admitted Runtime adapter may promote the status explicitly.
    setRuntimeObservation(observation: "ready"): void {
      if (disposed) throw new ElectronProjectionError("DISPOSED", 410);
      if (observation !== "ready" || availability === "unavailable") {
        throw new ElectronProjectionError("CONFLICT", 409);
      }
      availability = "ready";
    },
    invoke(request: ElectronProjectionRequest, signal?: AbortSignal): ElectronProjectionResult {
      if (disposed) throw new ElectronProjectionError("DISPOSED", 410);
      if (signal?.aborted) throw new ElectronProjectionError("CLIENT_CLOSED_REQUEST", 499);
      if (!isOperation(request.operation)) {
        throw new ElectronProjectionError("FORBIDDEN", 403);
      }
      assertCorrelation(request.correlationId);
      if (!isPositiveInteger(request.deadlineMs) || request.deadlineMs > 1_000) {
        throw new ElectronProjectionError("TIMEOUT", 408);
      }
      assertSessionValue(request.sessionGeneration, session.generation);
      assertSessionValue(request.parentEpoch, session.parentEpoch);
      assertSessionValue(request.revision, session.revision);
      return invokeResult(request.operation, availability, ownedSettings);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      availability = "unavailable";
    },
  };
}
