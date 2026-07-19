import type {
  DiagnosticHistoryDto,
  DiagnosticsClient,
  EventsClient,
  EventsConnectionState,
  EventsSnapshotDto,
} from "@mish/contracts";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  clearLocalEvents,
  createEventsBufferState,
  reconcileEventsSnapshot,
} from "../pages/events-model";
import { createFixtureEventsClient } from "./fixture-events-client";
import { createFixtureDiagnosticsClient } from "./fixture-diagnostics-client";

interface EventsContextValue {
  clearLocal(): void;
  connection: EventsConnectionState;
  cancelDiagnosticRun(runId: string): Promise<void>;
  diagnosticError: string | null;
  diagnosticHistory: DiagnosticHistoryDto | null;
  diagnosticPending: boolean;
  error: string | null;
  events: ReturnType<typeof createEventsBufferState>["events"];
  isLoading: boolean;
  snapshot: EventsSnapshotDto | null;
  startDiagnosticRun(): Promise<void>;
}

const EventsContext = createContext<EventsContextValue | null>(null);

interface EventsProviderProps {
  children: ReactNode;
  client?: EventsClient;
  diagnosticsClient?: DiagnosticsClient;
}

export function EventsProvider({ children, client, diagnosticsClient }: EventsProviderProps) {
  const resolvedClient = useMemo(() => client ?? createFixtureEventsClient(), [client]);
  const resolvedDiagnosticsClient = useMemo(
    () => diagnosticsClient ?? createFixtureDiagnosticsClient(),
    [diagnosticsClient],
  );
  const [snapshot, setSnapshot] = useState<EventsSnapshotDto | null>(null);
  const [connection, setConnection] = useState(() => resolvedClient.getConnectionState());
  const [buffer, setBuffer] = useState(createEventsBufferState);
  const [error, setError] = useState<string | null>(null);
  const [diagnosticHistory, setDiagnosticHistory] = useState<DiagnosticHistoryDto | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticPending, setDiagnosticPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const acceptSnapshot = (nextSnapshot: EventsSnapshotDto) => {
      setSnapshot(nextSnapshot);
      setBuffer((current) => reconcileEventsSnapshot(current, nextSnapshot));
      setError(null);
    };
    const unsubscribeConnection = resolvedClient.subscribeConnection(setConnection);
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots(acceptSnapshot);
    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then(acceptSnapshot)
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Events could not be loaded.");
      });

    return () => {
      controller.abort();
      unsubscribeConnection();
      unsubscribeSnapshots();
    };
  }, [resolvedClient]);

  useEffect(() => {
    const controller = new AbortController();
    resolvedDiagnosticsClient
      .getHistory({ signal: controller.signal })
      .then(setDiagnosticHistory)
      .catch(() => {
        if (!controller.signal.aborted) setDiagnosticError("Diagnostics could not be loaded.");
      });
    return () => controller.abort();
  }, [resolvedDiagnosticsClient]);

  useEffect(() => {
    if (!diagnosticHistory?.activeRunId) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      resolvedDiagnosticsClient
        .getHistory({ signal: controller.signal })
        .then((history) => {
          setDiagnosticHistory(history);
          setDiagnosticError(null);
          if (history.activeRunId) timeout = setTimeout(poll, 200);
        })
        .catch(() => {
          if (!controller.signal.aborted) setDiagnosticError("Diagnostics could not be refreshed.");
        });
    };
    timeout = setTimeout(poll, 200);
    return () => {
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [diagnosticHistory?.activeRunId, resolvedDiagnosticsClient]);

  const value = useMemo<EventsContextValue>(
    () => ({
      clearLocal: () => setBuffer((current) => clearLocalEvents(current)),
      cancelDiagnosticRun: async (runId) => {
        setDiagnosticPending(true);
        try {
          setDiagnosticHistory(await resolvedDiagnosticsClient.cancelRun(runId));
          setDiagnosticError(null);
        } catch {
          setDiagnosticError("The diagnostic run could not be cancelled.");
        } finally {
          setDiagnosticPending(false);
        }
      },
      connection,
      diagnosticError,
      diagnosticHistory,
      diagnosticPending,
      error,
      events: buffer.events,
      isLoading: snapshot === null && error === null,
      snapshot,
      startDiagnosticRun: async () => {
        setDiagnosticPending(true);
        try {
          setDiagnosticHistory(await resolvedDiagnosticsClient.startRun());
          setDiagnosticError(null);
        } catch {
          setDiagnosticError("The diagnostic run could not be started.");
        } finally {
          setDiagnosticPending(false);
        }
      },
    }),
    [
      buffer.events,
      connection,
      diagnosticError,
      diagnosticHistory,
      diagnosticPending,
      error,
      resolvedDiagnosticsClient,
      snapshot,
    ],
  );

  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEvents() {
  const context = useContext(EventsContext);
  if (!context) throw new Error("useEvents must be used inside EventsProvider");
  return context;
}
