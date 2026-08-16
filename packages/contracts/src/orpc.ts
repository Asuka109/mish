import { eventIterator, oc, type as schema } from "@orpc/contract";
import type { ContractRouterClient } from "@orpc/contract";

/**
 * The application transport contract is intentionally small at the cutover
 * boundary. Domain packages add procedures by extending this shared contract;
 * clients do not invent a second wire shape.
 */
export const ORPC_PROTOCOL_VERSION = 1 as const;
export const ORPC_CONTRACT_VERSION = 1 as const;

export const ORPC_CLIENT_NAMES = ["web", "electron", "react-native"] as const;
export type OrpcClientName = (typeof ORPC_CLIENT_NAMES)[number];

/**
 * Read-only product projections admitted at the shared session boundary.
 * Commands are intentionally absent until a domain actor and a native effect
 * seam are accepted for that operation.
 */
export const ORPC_OPERATIONS = [
  "status.snapshot",
  "routes.snapshot",
  "profile.refresh",
  "traffic.snapshot",
  "events.snapshot",
  "settings.snapshot",
] as const;
export type OrpcOperation = (typeof ORPC_OPERATIONS)[number];

export interface OrpcStatusData {
  readonly kind: "status";
  readonly phase: "ready" | "degraded" | "unavailable";
  readonly profileName: string | null;
  readonly activeConnections: number;
  readonly downloadBytesPerSecond: number;
  readonly uploadBytesPerSecond: number;
}

export interface OrpcRouteData {
  readonly kind: "routes";
  readonly groups: readonly {
    readonly id: string;
    readonly label: string;
    readonly selected: string | null;
    readonly children: readonly string[];
  }[];
}

export interface OrpcProfileData {
  readonly kind: "profiles";
  readonly profiles: readonly {
    readonly id: string;
    readonly name: string;
    readonly source: "file" | "subscription";
    readonly active: boolean;
    readonly updatedAt: string;
  }[];
}

export interface OrpcTrafficData {
  readonly kind: "traffic";
  readonly connections: readonly {
    readonly id: string;
    readonly destination: string;
    readonly protocol: string;
    readonly downloadBytes: number;
    readonly uploadBytes: number;
  }[];
  readonly rules: readonly {
    readonly id: string;
    readonly target: string;
    readonly action: string;
  }[];
}

export interface OrpcEventData {
  readonly kind: "events";
  readonly events: readonly {
    readonly id: string;
    readonly level: "debug" | "info" | "warning" | "error";
    readonly source: "application" | "core" | "platform" | "rpc";
    readonly message: string;
    readonly observedAt: string;
  }[];
}

export interface OrpcSettingsData {
  readonly kind: "settings";
  readonly appearance: "system" | "light" | "dark";
  readonly language: "en" | "zh-CN";
  readonly readOnly: true;
}

export type OrpcOperationData =
  | OrpcStatusData
  | OrpcRouteData
  | OrpcProfileData
  | OrpcTrafficData
  | OrpcEventData
  | OrpcSettingsData;

export const orpcContract = {
  session: {
    handshake: oc
      .route({ method: "POST", path: "/session/handshake" })
      .input(
        schema<{
          authToken: string;
          clientName: OrpcClientName;
          clientVersion: string;
          protocolVersion: typeof ORPC_PROTOCOL_VERSION;
          requestedDeadlineMs: number;
          requestedMaxMessageBytes: number;
        }>(),
      )
      .output(
        schema<{
          contractVersion: typeof ORPC_CONTRACT_VERSION;
          maxDeadlineMs: number;
          maxMessageBytes: number;
          parentEpoch: number;
          protocolVersion: typeof ORPC_PROTOCOL_VERSION;
          revision: number;
          sessionGeneration: number;
        }>(),
      ),
  },
  application: {
    invoke: oc
      .route({ method: "POST", path: "/application/invoke" })
      .input(
        schema<{
          correlationId: string;
          deadlineMs: number;
          operation: OrpcOperation;
          parentEpoch: number;
          revision: number;
          sessionGeneration: number;
        }>(),
      )
      .output(
        schema<{
          correlationId: string;
          operation: OrpcOperation;
          parentEpoch: number;
          revision: number;
          sessionGeneration: number;
          value: "accepted";
          /** A bounded read projection; absent for command-free fixtures. */
          data?: OrpcOperationData;
        }>(),
      ),
    events: {
      watch: oc
        .route({ method: "POST", path: "/application/events/watch" })
        .input(
          schema<{
            correlationId: string;
            parentEpoch: number;
            revision: number;
            sessionGeneration: number;
          }>(),
        )
        .output(
          eventIterator(
            schema<{
              correlationId: string;
              parentEpoch: number;
              revision: number;
              sequence: number;
              sessionGeneration: number;
              value: "changed" | "ready";
            }>(),
            schema<{
              correlationId: string;
              parentEpoch: number;
              revision: number;
              sessionGeneration: number;
              value: "closed";
            }>(),
          ),
        ),
    },
  },
} as const;

export type OrpcContractClient = ContractRouterClient<typeof orpcContract>;

export type OrpcHandshakeInput = Parameters<OrpcContractClient["session"]["handshake"]>[0];
export type OrpcHandshakeOutput = Awaited<ReturnType<OrpcContractClient["session"]["handshake"]>>;
export type OrpcInvokeInput = Parameters<OrpcContractClient["application"]["invoke"]>[0];
export type OrpcInvokeOutput = Awaited<ReturnType<OrpcContractClient["application"]["invoke"]>>;
export type OrpcEventInput = Parameters<OrpcContractClient["application"]["events"]["watch"]>[0];
export type OrpcEventValue =
  Awaited<ReturnType<OrpcContractClient["application"]["events"]["watch"]>> extends AsyncIterator<
    infer TValue
  >
    ? TValue
    : never;
export type OrpcEventReturn =
  Awaited<ReturnType<OrpcContractClient["application"]["events"]["watch"]>> extends AsyncIterator<
    unknown,
    infer TReturn
  >
    ? TReturn
    : never;
