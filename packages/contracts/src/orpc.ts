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

export const ORPC_OPERATIONS = ["status.snapshot", "profile.refresh"] as const;
export type OrpcOperation = (typeof ORPC_OPERATIONS)[number];

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
