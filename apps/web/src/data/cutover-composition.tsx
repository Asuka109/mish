import type { DomainActorSnapshot, DomainStateValue, RpcSessionContext } from "@mish/domain";
import {
  MishQueryProvider,
  createQueryClient,
  createStore,
  useMishStore,
  useQuery,
  useQueryClient,
} from "@mish/ui-state";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CUTOVER_SESSION_QUERY_KEY,
  CUTOVER_SESSION_STREAM_QUERY_KEY,
  createCutoverSessionActor,
  type CutoverSessionActorHandle,
  type CutoverSessionFactory,
  type CutoverSessionPort,
  type CutoverSessionQueryData,
  type CutoverSessionStreamData,
} from "./cutover-session-actor";
import { CutoverViewProvider, type CutoverViewSource } from "./cutover-view-facade";

type SessionPhase = "connected" | "connecting" | "disconnected" | "failed";

interface SessionPresentationState {
  readonly phase: SessionPhase;
  readonly pending: boolean;
  readonly error: boolean;
}

const INITIAL_PRESENTATION: SessionPresentationState = {
  error: false,
  pending: false,
  phase: "disconnected",
};

function stateName(value: DomainStateValue): string {
  return typeof value === "string" ? value : Object.keys(value).join(".");
}

function projectPresentation(
  snapshot: DomainActorSnapshot<RpcSessionContext>,
): SessionPresentationState {
  const value = stateName(snapshot.value);
  if (value === "connected-current") {
    return { error: false, pending: false, phase: "connected" };
  }
  if (
    value === "failed" ||
    value === "recoveryRequired" ||
    value === "disposeRecoveryRequired" ||
    snapshot.status === "error"
  ) {
    return { error: true, pending: false, phase: "failed" };
  }
  if (value === "disconnected" || value === "disposed" || snapshot.status === "stopped") {
    return { error: false, pending: false, phase: "disconnected" };
  }
  return { error: false, pending: true, phase: "connecting" };
}

function CutoverSessionProjection({
  session,
  onSourceChange,
}: {
  readonly session?: CutoverSessionFactory;
  readonly onSourceChange: (source: CutoverViewSource | null) => void;
}) {
  const queryClient = useQueryClient();
  const baseline = useQuery<CutoverSessionQueryData | null>({
    queryKey: CUTOVER_SESSION_QUERY_KEY,
    queryFn: async () => null,
    initialData: null,
    staleTime: 1_000,
    retry: 1,
    enabled: false,
  });
  const stream = useQuery<CutoverSessionStreamData | null>({
    queryKey: CUTOVER_SESSION_STREAM_QUERY_KEY,
    queryFn: async () => null,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
    enabled: false,
  });
  const [presentationStore] = useState(() => createStore(INITIAL_PRESENTATION));
  const presentation = useMishStore(presentationStore);
  const actorRef = useRef<CutoverSessionActorHandle["actor"] | null>(null);

  useEffect(() => {
    presentationStore.setState(INITIAL_PRESENTATION);
    if (!session) {
      actorRef.current = null;
      onSourceChange(null);
      return;
    }

    const actorSession: CutoverSessionPort = {
      authority: session.createAuthority(),
      createChannel: session.createChannel,
    };
    const source = actorSession.authority.invoke
      ? {
          invoke: actorSession.authority.invoke.bind(actorSession.authority),
        }
      : null;
    const handle = createCutoverSessionActor({
      queryClient,
      session: actorSession,
    });
    actorRef.current = handle.actor;
    const subscription = handle.actor.subscribe(
      (snapshot: DomainActorSnapshot<RpcSessionContext>) => {
        presentationStore.setState(projectPresentation(snapshot));
        onSourceChange(
          source && projectPresentation(snapshot).phase === "connected" ? source : null,
        );
      },
    );

    handle.actor.start();
    presentationStore.setState(projectPresentation(handle.actor.getSnapshot()));
    onSourceChange(null);
    handle.actor.send({ type: "CONNECT" });

    return () => {
      subscription.unsubscribe();
      actorRef.current = null;
      onSourceChange(null);
      void handle.dispose().catch(() => undefined);
    };
  }, [onSourceChange, presentationStore, queryClient, session]);

  const reconnect = useCallback(() => {
    const actor = actorRef.current;
    if (!actor) return;
    actor.send({ type: "RECONNECT" });
  }, []);

  if (!session) return null;

  const label = baseline.data
    ? presentation.phase === "connected"
      ? "Connected"
      : presentation.phase === "connecting"
        ? "Connecting"
        : presentation.error
          ? "Session failed"
          : "Session is stale"
    : presentation.phase === "connecting"
      ? "Connecting"
      : presentation.error
        ? "Session failed"
        : "Session is disconnected";

  return (
    <div
      className="pointer-events-none fixed inset-x-4 top-4 z-50 flex justify-end"
      data-cutover-session={presentation.phase}
      data-last-sequence={stream.data?.lastSequence ?? undefined}
      data-last-value={stream.data?.lastValue ?? undefined}
    >
      <output aria-live="polite" aria-atomic="true" className="sr-only">
        {label}
      </output>
      {presentation.error ? (
        <button
          className="pointer-events-auto min-h-11 rounded-md border border-hairline-soft bg-canvas px-3 text-metadata font-medium text-ink shadow-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          aria-label="Reconnect"
          disabled={presentation.pending}
          onClick={reconnect}
        >
          Reconnect
        </button>
      ) : null}
    </div>
  );
}

/**
 * Production Web composition for the CUT-03 session boundary. It creates one
 * Query client and one XState domain actor. Remote snapshots remain in Query
 * and streamed events are bounded by the shared UI-state adapter.
 */
export function CutoverWebComposition({
  children,
  session,
}: {
  readonly children: ReactNode;
  readonly session?: CutoverSessionFactory;
}) {
  const [queryClient] = useState(createQueryClient);
  const [viewSource, setViewSource] = useState<CutoverViewSource | null>(null);
  return (
    <MishQueryProvider client={queryClient}>
      <CutoverSessionProjection session={session} onSourceChange={setViewSource} />
      <CutoverViewProvider source={viewSource}>{children}</CutoverViewProvider>
    </MishQueryProvider>
  );
}
