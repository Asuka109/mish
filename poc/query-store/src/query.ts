import { MutationObserver, QueryClient } from "@tanstack/query-core";
import type {
  FetchQueryOptions,
  MutationKey,
  MutationObserverOptions,
  QueryKey,
} from "@tanstack/query-core";

/**
 * A contract-first oRPC procedure. The transport and envelope stay in the
 * oRPC admission POC; this package only supplies the Query cache policy.
 */
export type OrpcProcedure<TInput, TOutput> = (input: TInput) => Promise<TOutput>;

export type OrpcQueryOptions<TOutput, TError = Error> = Pick<
  FetchQueryOptions<TOutput, TError, TOutput, QueryKey>,
  "queryKey" | "retry" | "retryDelay" | "staleTime"
>;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function createOrpcQueryOptions<TInput, TOutput, TError = Error>(
  procedure: OrpcProcedure<TInput, TOutput>,
  input: TInput,
  options: OrpcQueryOptions<TOutput, TError>,
): FetchQueryOptions<TOutput, TError, TOutput, QueryKey> {
  return {
    queryKey: options.queryKey,
    queryFn: () => procedure(input),
    retry: options.retry,
    retryDelay: options.retryDelay,
    staleTime: options.staleTime,
  };
}

export function fetchOrpcQuery<TInput, TOutput, TError = Error>(
  client: QueryClient,
  procedure: OrpcProcedure<TInput, TOutput>,
  input: TInput,
  options: OrpcQueryOptions<TOutput, TError>,
): Promise<TOutput> {
  return client.fetchQuery(createOrpcQueryOptions(procedure, input, options));
}

export interface OrpcMutationOptions<TError = Error> {
  readonly mutationKey?: MutationKey;
  readonly retry?: MutationObserverOptions<unknown, TError, unknown>["retry"];
  readonly retryDelay?: MutationObserverOptions<unknown, TError, unknown>["retryDelay"];
  readonly invalidateKeys?: readonly QueryKey[];
}

export interface OrpcMutation<TInput, TOutput, TError = Error> {
  readonly execute: (input: TInput) => Promise<TOutput>;
  readonly getState: () => ReturnType<
    MutationObserver<TOutput, TError, TInput>["getCurrentResult"]
  >;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createOrpcMutation<TInput, TOutput, TError = Error>(
  client: QueryClient,
  procedure: OrpcProcedure<TInput, TOutput>,
  options: OrpcMutationOptions<TError> = {},
): OrpcMutation<TInput, TOutput, TError> {
  const mutationOptions: MutationObserverOptions<TOutput, TError, TInput> = {
    mutationKey: options.mutationKey,
    mutationFn: (input) => procedure(input),
    retry: options.retry,
    retryDelay: options.retryDelay,
    onSuccess: async () => {
      await Promise.all(
        (options.invalidateKeys ?? []).map((queryKey) =>
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
