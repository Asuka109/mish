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
import { QueryClientProvider, useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

/**
 * Type of the official oRPC utility returned by createProcedureUtils. Keeping
 * this alias public makes the production adapter consume the package's own
 * generated query keys and query functions instead of recreating them.
 */
export type OrpcProcedureUtils<
  TContext extends ClientContext,
  TInput,
  TOutput,
  TError,
> = ReturnType<typeof createProcedureUtils<TContext, TInput, TOutput, TError>>;

/**
 * Query is the sole owner of remote snapshots. The retry default is bounded
 * and can only be overridden with another finite policy by callers.
 */
export const DEFAULT_QUERY_RETRY = 1 as const;
export const DEFAULT_QUERY_RETRY_DELAY_MS = 250 as const;
export const MAX_QUERY_RETRIES = 3 as const;

/** Retry counts admitted by the shared query boundary. */
export type BoundedRetry = 0 | 1 | 2 | 3;

type BoundedRetryOption = BoundedRetry;

function assertBoundedRetry(value: unknown, label: string): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_QUERY_RETRIES
  ) {
    throw new RangeError(`${label} must be an integer in [0, ${MAX_QUERY_RETRIES}]`);
  }
}

export interface MishQueryClientOptions {
  readonly queryRetry?: BoundedRetryOption;
  readonly mutationRetry?: BoundedRetryOption;
}

type BoundedQueryOptions<
  TContext extends ClientContext,
  TInput,
  TOutput,
  TError,
  TSelectData,
> = Omit<QueryOptionsIn<TContext, TInput, TOutput, TError, TSelectData>, "retry"> & {
  readonly retry?: BoundedRetryOption;
};

type BoundedStreamedOptions<
  TContext extends ClientContext,
  TInput,
  TOutput,
  TError,
  TSelectData,
> = Omit<
  experimental_StreamedOptionsIn<TContext, TInput, TOutput, TError, TSelectData>,
  "retry"
> & {
  readonly retry?: BoundedRetryOption;
};

type BoundedMutationOptions<
  TContext extends ClientContext,
  TInput,
  TOutput,
  TError,
  TMutationContext,
> = Omit<MutationOptionsIn<TContext, TInput, TOutput, TError, TMutationContext>, "retry"> & {
  readonly retry?: BoundedRetryOption;
};

export function createQueryClient(options: MishQueryClientOptions = {}): QueryClient {
  assertBoundedRetry(options.queryRetry, "queryRetry");
  assertBoundedRetry(options.mutationRetry, "mutationRetry");
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: options.queryRetry ?? DEFAULT_QUERY_RETRY,
        retryDelay: DEFAULT_QUERY_RETRY_DELAY_MS,
      },
      mutations: {
        retry: options.mutationRetry ?? DEFAULT_QUERY_RETRY,
        retryDelay: DEFAULT_QUERY_RETRY_DELAY_MS,
      },
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
  TOptions extends BoundedQueryOptions<TContext, TInput, TOutput, TError, TOutput>,
>(
  utils: OrpcProcedureUtils<TContext, TInput, TOutput, TError>,
  options: TOptions,
): TOptions & Omit<QueryOptionsBase<TOutput, TError>, keyof TOptions> {
  assertBoundedRetry((options as { readonly retry?: unknown }).retry, "query retry");
  return utils.queryOptions(
    options as QueryOptionsIn<TContext, TInput, TOutput, TError, TOutput>,
  ) as unknown as TOptions & Omit<QueryOptionsBase<TOutput, TError>, keyof TOptions>;
}

export function fetchOrpcQuery<TContext extends ClientContext, TInput, TOutput, TError>(
  client: QueryClient,
  utils: OrpcProcedureUtils<TContext, TInput, TOutput, TError>,
  options: BoundedQueryOptions<TContext, TInput, TOutput, TError, TOutput>,
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
  options: BoundedStreamedOptions<TContext, TInput, TEvent[], TError, TEvent[]>,
) {
  assertBoundedRetry((options as { readonly retry?: unknown }).retry, "streamed query retry");
  return utils.experimental_streamedOptions(
    options as experimental_StreamedOptionsIn<TContext, TInput, TEvent[], TError, TEvent[]>,
  );
}

export interface OrpcMutation<TInput, TOutput, TError = Error> {
  readonly execute: (input: TInput) => Promise<TOutput>;
  readonly getState: () => ReturnType<
    MutationObserver<TOutput, TError, TInput>["getCurrentResult"]
  >;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Use the official oRPC mutation options and invalidate only Query keys. No
 * mutation result is mirrored into the UI Store.
 */
export function createOrpcMutation<TContext extends ClientContext, TInput, TOutput, TError>(
  client: QueryClient,
  utils: OrpcProcedureUtils<TContext, TInput, TOutput, TError>,
  options: BoundedMutationOptions<TContext, TInput, TOutput, TError, unknown> & {
    readonly invalidateKeys?: readonly QueryKey[];
  },
): OrpcMutation<TInput, TOutput, TError> {
  assertBoundedRetry((options as { readonly retry?: unknown }).retry, "mutation retry");
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

/**
 * React Query composition is intentionally renderer neutral. The Web app can
 * use this provider while RN can compose the same client with its own root.
 */
export function MishQueryProvider({
  client,
  children,
}: {
  readonly client: QueryClient;
  readonly children: ReactNode;
}) {
  return createElement(QueryClientProvider, { client }, children);
}

export { useMutation, useQuery, useQueryClient };
