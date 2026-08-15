import { createORPCClient } from "@orpc/client";
import type { Client, ClientLink } from "@orpc/client";
import { eventIterator, oc, type ContractRouterClient, type as schema } from "@orpc/contract";

import { createOrpcProcedureUtils } from "../src/query.ts";

export interface StatusInput {
  readonly id: string;
}

export interface StatusOutput {
  readonly id: string;
  readonly revision: number;
}

export interface StreamEvent {
  readonly id: number;
}

const statusContract = oc
  .route({ method: "POST", path: "/status" })
  .input(schema<StatusInput>())
  .output(schema<StatusOutput>());
type StatusClient = ContractRouterClient<typeof statusContract>;

const streamContract = oc
  .route({ method: "POST", path: "/events" })
  .input(schema<{ readonly id: string }>())
  .output(eventIterator(schema<StreamEvent>(), schema<{ readonly done: true }>()));
type StreamClient = ContractRouterClient<typeof streamContract>;

type FixtureLink = ClientLink<Record<never, never>>;

export function createStatusFixture(
  handler: (input: StatusInput, path: readonly string[]) => Promise<StatusOutput>,
) {
  const link: FixtureLink = {
    call: (path, input) => handler(input as StatusInput, path),
  };
  const client = createORPCClient<StatusClient>(link, { path: ["status"] }) as unknown as Client<
    Record<never, never>,
    StatusInput,
    StatusOutput,
    Error
  >;
  const utils = createOrpcProcedureUtils<Record<never, never>, StatusInput, StatusOutput, Error>(
    client,
    ["status"],
  );
  return { client, utils };
}

export function createStreamFixture(
  handler: (input: { readonly id: string }, path: readonly string[]) => AsyncIterable<StreamEvent>,
) {
  const link: FixtureLink = {
    call: async (path, input) => handler(input as { readonly id: string }, path),
  };
  const client = createORPCClient<StreamClient>(link, { path: ["events"] }) as unknown as Client<
    Record<never, never>,
    { readonly id: string },
    AsyncIterable<StreamEvent>,
    Error
  >;
  const utils = createOrpcProcedureUtils<
    Record<never, never>,
    { readonly id: string },
    AsyncIterable<StreamEvent>,
    Error
  >(client, ["events"]);
  return { client, utils };
}
