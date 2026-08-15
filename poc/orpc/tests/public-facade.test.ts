import { describe, expect, it } from "vitest";

import {
  createORPCClient,
  createProcedureUtils,
  eventIterator,
  oc,
  type as schema,
} from "@mish/poc-orpc";
import type {
  Client,
  ClientContext,
  ClientLink,
  ContractRouterClient,
  MutationOptionsIn,
  ProcedureUtils,
  QueryOptionsIn,
  experimental_StreamedOptionsIn,
} from "@mish/poc-orpc";

const facadeContract = {
  ping: oc
    .route({ method: "POST", path: "/ping" })
    .input(schema<{ value: string }>())
    .output(schema<{ value: number }>()),
  updates: oc
    .route({ method: "POST", path: "/updates" })
    .input(schema<{ value: string }>())
    .output(eventIterator(schema<number>())),
} as const;

type FacadeContractClient = ContractRouterClient<typeof facadeContract>;
type FacadeContext = Record<never, never>;
type FacadeInput = { value: string };
type FacadeOutput = { value: number };
type FacadeError = Error;
type FacadeClient = Client<FacadeContext, FacadeInput, FacadeOutput, FacadeError>;
type FacadeQueryOptions = QueryOptionsIn<
  FacadeContext,
  FacadeInput,
  FacadeOutput,
  FacadeError,
  FacadeOutput
>;
type FacadeMutationOptions = MutationOptionsIn<
  FacadeContext,
  FacadeInput,
  FacadeOutput,
  FacadeError,
  unknown
>;
type FacadeStreamedOptions = experimental_StreamedOptionsIn<
  FacadeContext,
  FacadeInput,
  number[],
  FacadeError,
  number[]
>;

function publicFacadeTypecheck(
  contractClient: FacadeContractClient,
  client: FacadeClient,
  link: ClientLink<ClientContext>,
): ProcedureUtils<FacadeContext, FacadeInput, FacadeOutput, FacadeError> {
  const utils = createProcedureUtils(client, { path: ["ping"] });
  const queryOptions: FacadeQueryOptions = { input: { value: "query" } };
  const mutationOptions: FacadeMutationOptions = {};
  const streamedOptions: FacadeStreamedOptions = { input: { value: "stream" } };

  void contractClient;
  void link;
  void queryOptions;
  void mutationOptions;
  void streamedOptions;
  return utils;
}

void publicFacadeTypecheck;

describe("oRPC public facade", () => {
  it("re-exports the pinned public client, contract, and query APIs", () => {
    expect(typeof createORPCClient).toBe("function");
    expect(typeof createProcedureUtils).toBe("function");
    expect(typeof eventIterator).toBe("function");
    expect(typeof oc.route).toBe("function");
    expect(typeof schema).toBe("function");
    expect(facadeContract.ping).toBeDefined();
    expect(facadeContract.updates).toBeDefined();
  });
});
