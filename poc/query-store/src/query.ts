import { MutationObserver, QueryClient } from "@tanstack/query-core";
import type { Client, ClientContext } from "@orpc/client";
import { createProcedureUtils } from "@orpc/tanstack-query";
import type {
  experimental_StreamedOptionsIn,
  MutationOptionsIn,
  QueryOptionsBase,
  QueryOptionsIn,
} from "@orpc/tanstack-query";
import type { FetchQueryOptions, MutationObserverOptions, QueryKey } from "@tanstack/query-core";

/**
 * The official oRPC 1.15.0 TanStack Query utility. It is intentionally kept
 * as the public boundary: this POC does not recreate oRPC query keys,
 * mutation functions, or Event Iterator handling.
 */
export type OrpcProcedureUtils<
  TContext extends ClientContext,
  TInput,
  TOutput,
  TError,
> = ReturnType<typeof createProcedureUtils<TContext, TInput, TOutput, TError>>;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function createOrpcProcedureUtils<TContext extends ClientContext, TInput, TOutput, TError>(
  client: Client<TContext, TInput, TOutput, TError>,
  path: readonly string[],
): OrpcProcedureUtils<TContext, TInput, TOutput, TError> {
  return createProcedureUtils(client, { path });
}

export function createOrpcQueryOptions<
  TContext extends ClientContext,
  TInput,
  TOutput,
  TError,
  TOptions extends QueryOptionsIn<TContext, TInput, TOutput, TError, TOutput>,
>(
  utils: OrpcProcedureUtils<TContext, TInput, TOutput, TError>,
  options: TOptions,
): TOptions & Omit<QueryOptionsBase<TOutput, TError>, keyof TOptions> {
  return utils.queryOptions(options) as TOptions &
    Omit<QueryOptionsBase<TOutput, TError>, keyof TOptions>;
}

export function fetchOrpcQuery<TContext extends ClientContext, TInput, TOutput, TError>(
  client: QueryClient,
  utils: OrpcProcedureUtils<TContext, TInput, TOutput, TError>,
  options: QueryOptionsIn<TContext, TInput, TOutput, TError, TOutput>,
): Promise<TOutput> {
  const generated = createOrpcQueryOptions(utils, options) as FetchQueryOptions<
    TOutput,
    TError,
    TOutput,
    QueryKey
  >;
  return client.fetchQuery(generated);
}

export function createOrpcStreamedOptions<TContext extends ClientContext, TInput, TEvent, TError>(
  utils: OrpcProcedureUtils<TContext, TInput, AsyncIterable<TEvent>, TError>,
  options: experimental_StreamedOptionsIn<TContext, TInput, TEvent[], TError, TEvent[]>,
) {
  return utils.experimental_streamedOptions(options);
}

export interface OrpcMutation<TInput, TOutput, TError = Error> {
  readonly execute: (input: TInput) => Promise<TOutput>;
  readonly getState: () => ReturnType<
    MutationObserver<TOutput, TError, TInput>["getCurrentResult"]
  >;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createOrpcMutation<TContext extends ClientContext, TInput, TOutput, TError>(
  client: QueryClient,
  utils: OrpcProcedureUtils<TContext, TInput, TOutput, TError>,
  options: MutationOptionsIn<TContext, TInput, TOutput, TError, unknown> & {
    readonly invalidateKeys?: readonly QueryKey[];
  },
): OrpcMutation<TInput, TOutput, TError> {
  const { invalidateKeys, ...officialOptions } = options;
  const generated = utils.mutationOptions(
    officialOptions as MutationOptionsIn<TContext, TInput, TOutput, TError, unknown>,
  );
  const mutationOptions: MutationObserverOptions<TOutput, TError, TInput> = {
    ...generated,
    onSuccess: async (data, input, onMutateResult, context) => {
      await generated.onSuccess?.(data, input, onMutateResult, context);
      await Promise.all(
        (invalidateKeys ?? []).map((queryKey) =>
          client.invalidateQueries({
            queryKey,
            exact: true,
            refetchType: "none",
          }),
        ),
      );
    },
  };
  const observer = new MutationObserver(client, mutationOptions);

  return {
    execute: (input) => observer.mutate(input),
    getState: () => observer.getCurrentResult(),
    subscribe: (listener) => observer.subscribe(() => listener()),
  };
}
