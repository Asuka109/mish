import { eventIterator, oc, type as schema } from "@orpc/contract";
import type { ContractRouterClient } from "@orpc/contract";

/**
 * The POC speaks only through this contract.  The transport adapters never
 * construct a second wire format or reinterpret these procedures.
 */
export const orpcContract = {
  session: {
    handshake: oc
      .route({ method: "POST", path: "/session/handshake" })
      .input(
        schema<{
          authToken: string;
          clientName: "web" | "electron";
          clientVersion: string;
          protocolVersion: number;
        }>(),
      )
      .output(
        schema<{
          maxMessageBytes: number;
          protocolVersion: number;
          sessionGeneration: number;
        }>(),
      ),
  },
  invoke: oc
    .route({ method: "POST", path: "/invoke" })
    .input(
      schema<{
        correlationId: string;
        deadlineMs: number;
        operation: "status.snapshot" | "profile.refresh";
        sessionGeneration: number;
      }>(),
    )
    .output(
      schema<{
        correlationId: string;
        operation: "status.snapshot" | "profile.refresh";
        sessionGeneration: number;
        value: "ok";
      }>(),
    ),
  events: {
    watch: oc
      .route({ method: "POST", path: "/events/watch" })
      .input(
        schema<{
          correlationId: string;
          sessionGeneration: number;
        }>(),
      )
      .output(
        eventIterator(
          schema<{
            correlationId: string;
            sequence: number;
            sessionGeneration: number;
            value: "ready" | "changed";
          }>(),
          schema<{
            correlationId: string;
            sessionGeneration: number;
            value: "closed";
          }>(),
        ),
      ),
  },
} as const;

export type ORPCContractClient = ContractRouterClient<typeof orpcContract>;

export type HandshakeInput = Parameters<ORPCContractClient["session"]["handshake"]>[0];
export type HandshakeOutput = Awaited<ReturnType<ORPCContractClient["session"]["handshake"]>>;
export type InvokeInput = Parameters<ORPCContractClient["invoke"]>[0];
export type InvokeOutput = Awaited<ReturnType<ORPCContractClient["invoke"]>>;
export type EventInput = Parameters<ORPCContractClient["events"]["watch"]>[0];
export type EventValue =
  Awaited<ReturnType<ORPCContractClient["events"]["watch"]>> extends AsyncIterator<infer T>
    ? T
    : never;

export type EventIteratorReturn =
  Awaited<ReturnType<ORPCContractClient["events"]["watch"]>> extends AsyncIterator<
    unknown,
    infer TReturn
  >
    ? TReturn
    : never;
