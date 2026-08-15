import React, { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MishQueryProvider,
  createQueryClient,
  createStore,
  useMishStore,
  useQuery,
} from "@mish/ui-state";
import type { DomainActorSnapshot, RpcSessionContext } from "@mish/domain";

import {
  ELECTRON_SESSION_STREAM_QUERY_KEY,
  createElectronSessionActor,
  type ElectronSessionStreamData,
} from "./session.js";
import type { ElectronHostApi, RendererStoreReport } from "./electron-api.js";

interface PresentationState {
  readonly phase: "connected" | "connecting" | "disconnected" | "failed";
  readonly events: number;
  readonly invocationAccepted: boolean;
  readonly notifications: number;
}

const INITIAL_PRESENTATION: PresentationState = {
  phase: "disconnected",
  events: 0,
  invocationAccepted: false,
  notifications: 0,
};

function actorState(snapshot: DomainActorSnapshot<RpcSessionContext>): PresentationState["phase"] {
  const value =
    typeof snapshot.value === "string" ? snapshot.value : Object.keys(snapshot.value)[0];
  if (value === "connected-current") return "connected";
  if (value === "failed" || value === "recoveryRequired" || snapshot.status === "error") {
    return "failed";
  }
  if (value === "disconnected" || value === "disposed" || snapshot.status === "stopped") {
    return "disconnected";
  }
  return "connecting";
}

function isCurrentEpoch(ref: { readonly current: number }, epoch: number): boolean {
  return ref.current === epoch;
}

function StoreSurface({
  api,
  label,
  events,
  onCleanup,
  onNotify,
}: {
  readonly api: ElectronHostApi;
  readonly label: "first" | "remount";
  readonly events: number;
  readonly onCleanup: () => void;
  readonly onNotify: () => void;
}) {
  const notified = useRef(false);
  useEffect(() => {
    const report: RendererStoreReport = { kind: "store-mounted", label };
    api.reportStore(report);
    return () => {
      api.reportStore({ kind: "store-cleaned", label });
      onCleanup();
    };
  }, [api, label, onCleanup]);
  useEffect(() => {
    if (events < 1 || notified.current) return;
    notified.current = true;
    api.reportStore({ kind: "store-notified", count: events });
    onNotify();
  }, [api, events, onNotify]);
  return <output data-electron-events={events}>{label}</output>;
}

function ElectronApplication({
  api,
  queryClient,
}: {
  readonly api: ElectronHostApi;
  readonly queryClient: ReturnType<typeof createQueryClient>;
}) {
  const [presentationStore] = useState(() => createStore(INITIAL_PRESENTATION));
  const presentation = useMishStore(presentationStore);
  const [surfaceLabel, setSurfaceLabel] = useState<"first" | "remount">("first");
  const surfaceCleanupCount = useRef(0);
  const surfaceNotificationCount = useRef(0);
  const startedEpoch = useRef(0);
  const sessionStarted = useRef(false);
  const readyReported = useRef(false);
  const disposedForReady = useRef(false);
  const invoked = useRef(false);
  const handle = useMemo(
    () => createElectronSessionActor({ api, queryClient }),
    [api, queryClient],
  );
  const onSurfaceCleanup = useCallback(() => {
    surfaceCleanupCount.current += 1;
  }, []);
  const onSurfaceNotify = useCallback(() => {
    surfaceNotificationCount.current += 1;
  }, []);
  const stream = useQuery<ElectronSessionStreamData | undefined>({
    queryKey: ELECTRON_SESSION_STREAM_QUERY_KEY,
    queryFn: async () => undefined,
    enabled: false,
    initialData: undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    const epoch = ++startedEpoch.current;
    const applySnapshot = (snapshot: DomainActorSnapshot<RpcSessionContext>): void => {
      const phase = actorState(snapshot);
      presentationStore.batch(() => {
        presentationStore.setState((current) => ({ ...current, phase }));
      });
      if (phase === "connected" && !invoked.current) {
        invoked.current = true;
        void api
          .invoke("status.snapshot", 250)
          .then(() => {
            presentationStore.batch(() => {
              presentationStore.setState((current) => ({ ...current, invocationAccepted: true }));
            });
            api.reportStore({ kind: "store-batched", count: 2 });
            setSurfaceLabel("remount");
            return undefined;
          })
          .catch(() => {
            api.reportFailure({ stage: "invoke", message: "admission-failed" });
            return undefined;
          });
      }
    };
    const subscription = handle.actor.subscribe(applySnapshot);
    if (!sessionStarted.current) {
      sessionStarted.current = true;
      handle.actor.start();
      applySnapshot(handle.actor.getSnapshot());
      handle.actor.send({ type: "CONNECT" });
    } else {
      applySnapshot(handle.actor.getSnapshot());
    }
    return () => {
      subscription.unsubscribe();
      queueMicrotask(() => {
        if (isCurrentEpoch(startedEpoch, epoch)) void handle.dispose();
      });
    };
  }, [api, handle, presentationStore]);

  useEffect(() => {
    const events = stream.data?.chunks.length ?? 0;
    if (events === 0) return;
    presentationStore.setState((current) => ({
      ...current,
      events,
      notifications: Math.max(current.notifications, events),
    }));
    if (surfaceNotificationCount.current === 0) {
      surfaceNotificationCount.current = events;
    }
  }, [presentationStore, stream.data]);

  useEffect(() => {
    if (
      readyReported.current ||
      disposedForReady.current ||
      surfaceLabel !== "remount" ||
      presentation.phase !== "connected" ||
      !presentation.invocationAccepted ||
      presentation.events < 2 ||
      surfaceCleanupCount.current < 1
    ) {
      return;
    }
    readyReported.current = true;
    disposedForReady.current = true;
    const session = {
      connected: true as const,
      generation: handle.authority.sessionGeneration,
      parentEpoch: handle.authority.parentEpoch,
      revision: handle.authority.revision,
    };
    void handle.dispose().then(() => {
      api.rendererReady({
        session,
        events: presentation.events,
        store: {
          notifications: Math.max(1, surfaceNotificationCount.current),
          cleanups: Math.max(1, surfaceCleanupCount.current),
          remounted: true,
        },
        strictMode: true,
      });
      return undefined;
    });
  }, [api, handle, presentation, surfaceLabel]);

  const statusText =
    presentation.phase === "connected"
      ? "Connected"
      : presentation.phase === "connecting"
        ? "Connecting"
        : presentation.phase === "failed"
          ? "Session unavailable"
          : "Starting";

  return (
    <main aria-live="polite" data-electron-session={presentation.phase}>
      <h1>Mish</h1>
      <p>{statusText}</p>
      <StoreSurface
        key={surfaceLabel}
        api={api}
        label={surfaceLabel}
        events={presentation.events}
        onCleanup={onSurfaceCleanup}
        onNotify={onSurfaceNotify}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Electron renderer root is missing");
const api = window.mishElectron;
const queryClient = createQueryClient();
createRoot(root).render(
  <StrictMode>
    <MishQueryProvider client={queryClient}>
      <ElectronApplication api={api} queryClient={queryClient} />
    </MishQueryProvider>
  </StrictMode>,
);
