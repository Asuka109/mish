import type {
  OrpcEventData,
  OrpcOperation,
  OrpcProfileData,
  OrpcRouteData,
  OrpcSettingsData,
  OrpcStatusData,
  OrpcTrafficData,
} from "@mish/contracts";
import { useContext, createContext, type ReactNode } from "react";
import { useQuery, type QueryKey } from "@mish/ui-state";
import type { OrpcInvokeOutput } from "@mish/contracts";

export const CUTOVER_VIEW_QUERY_PREFIX = ["web", "orpc", "view"] as const;

export type CutoverViewDataByOperation = {
  "status.snapshot": OrpcStatusData;
  "routes.snapshot": OrpcRouteData;
  "profile.refresh": OrpcProfileData;
  "traffic.snapshot": OrpcTrafficData;
  "events.snapshot": OrpcEventData;
  "settings.snapshot": OrpcSettingsData;
};

export const CUTOVER_VIEW_OPERATIONS = [
  "status.snapshot",
  "routes.snapshot",
  "profile.refresh",
  "traffic.snapshot",
  "events.snapshot",
  "settings.snapshot",
] as const satisfies readonly OrpcOperation[];

export type CutoverViewSource = {
  readonly invoke: (
    operation: OrpcOperation,
    options?: { readonly deadlineMs?: number; readonly signal?: AbortSignal },
  ) => Promise<OrpcInvokeOutput>;
};

const CutoverViewContext = createContext<CutoverViewSource | null>(null);

export function CutoverViewProvider({
  children,
  source,
}: {
  readonly children: ReactNode;
  readonly source: CutoverViewSource | null;
}) {
  return <CutoverViewContext.Provider value={source}>{children}</CutoverViewContext.Provider>;
}

export function cutoverViewQueryKey(operation: OrpcOperation): QueryKey {
  return [...CUTOVER_VIEW_QUERY_PREFIX, operation];
}

/**
 * The Web pages read remote projections through Query. The only caller of
 * `invoke` is the official oRPC session authority supplied by the XState
 * composition; this hook owns neither transport state nor lifecycle state.
 */
export function useCutoverView<TOperation extends OrpcOperation>(operation: TOperation) {
  const source = useContext(CutoverViewContext);
  return useQuery<CutoverViewDataByOperation[TOperation] | undefined>({
    queryKey: cutoverViewQueryKey(operation),
    queryFn: async ({ signal }) => {
      if (!source) return undefined;
      const result = await source.invoke(operation, { signal, deadlineMs: 500 });
      return result.data as CutoverViewDataByOperation[TOperation] | undefined;
    },
    enabled: source !== null,
    staleTime: 1_000,
    retry: 1,
  });
}
