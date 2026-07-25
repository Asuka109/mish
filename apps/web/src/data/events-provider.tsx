import type {
  DiagnosticHistoryDto,
  DiagnosticsClient,
  EventsClient,
  EventsConnectionState,
  EventsSnapshotDto,
  SupportBundleClient,
  SupportBundlePreviewDto,
} from "@mish/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  clearLocalEvents,
  createEventsBufferState,
  reconcileEventsSnapshot,
} from "../pages/events-model";
import { createFixtureEventsClient } from "./fixture-events-client";
import { createFixtureDiagnosticsClient } from "./fixture-diagnostics-client";
import { UnavailableSupportBundleClient } from "../platform/support-bundle";

type SupportBundleResult = "idle" | "cancelled" | "written" | "failed";

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
  clearSupportBundlePreview(): void;
  previewSupportBundle(): Promise<void>;
  saveSupportBundle(previewId: string): Promise<void>;
  supportBundleAvailability: SupportBundleClient["availability"];
  supportBundlePending: boolean;
  supportBundlePreview: SupportBundlePreviewDto | null;
  supportBundleResult: SupportBundleResult;
}

const EventsContext = createContext<EventsContextValue | null>(null);
const diagnosticPollIntervalMilliseconds = 200;
const diagnosticMaximumRetryMilliseconds = 2_000;

interface EventsProviderProps {
  children: ReactNode;
  client?: EventsClient;
  diagnosticsClient?: DiagnosticsClient;
  supportBundleClient?: SupportBundleClient;
}

export function EventsProvider({
  children,
  client,
  diagnosticsClient,
  supportBundleClient,
}: EventsProviderProps) {
  const resolvedClient = useMemo(() => client ?? createFixtureEventsClient(), [client]);
  const resolvedDiagnosticsClient = useMemo(
    () => diagnosticsClient ?? createFixtureDiagnosticsClient(),
    [diagnosticsClient],
  );
  const resolvedSupportBundleClient = useMemo(
    () => supportBundleClient ?? new UnavailableSupportBundleClient(),
    [supportBundleClient],
  );
  const [snapshot, setSnapshot] = useState<EventsSnapshotDto | null>(null);
  const [connection, setConnection] = useState(() => resolvedClient.getConnectionState());
  const [buffer, setBuffer] = useState(createEventsBufferState);
  const [error, setError] = useState<string | null>(null);
  const [diagnosticHistory, setDiagnosticHistory] = useState<DiagnosticHistoryDto | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticPending, setDiagnosticPending] = useState(false);
  const diagnosticRequest = useRef(0);
  const [supportBundlePending, setSupportBundlePending] = useState(false);
  const [supportBundlePreview, setSupportBundlePreview] = useState<SupportBundlePreviewDto | null>(
    null,
  );
  const [supportBundleResult, setSupportBundleResult] = useState<SupportBundleResult>("idle");

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
    const request = ++diagnosticRequest.current;
    resolvedDiagnosticsClient
      .getHistory({ signal: controller.signal })
      .then((history) => {
        if (request === diagnosticRequest.current) setDiagnosticHistory(history);
      })
      .catch(() => {
        if (!controller.signal.aborted && request === diagnosticRequest.current) {
          setDiagnosticError("Diagnostics could not be loaded.");
        }
      });
    return () => controller.abort();
  }, [resolvedDiagnosticsClient]);

  useEffect(() => {
    if (!diagnosticHistory?.activeRunId) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let retryMilliseconds = diagnosticPollIntervalMilliseconds;
    const poll = () => {
      const request = ++diagnosticRequest.current;
      resolvedDiagnosticsClient
        .getHistory({ signal: controller.signal })
        .then((history) => {
          if (request !== diagnosticRequest.current) return;
          setDiagnosticHistory(history);
          setDiagnosticError(null);
          retryMilliseconds = diagnosticPollIntervalMilliseconds;
          if (history.activeRunId) timeout = setTimeout(poll, diagnosticPollIntervalMilliseconds);
        })
        .catch(() => {
          if (!controller.signal.aborted && request === diagnosticRequest.current) {
            setDiagnosticError("Diagnostics could not be refreshed.");
            timeout = setTimeout(poll, retryMilliseconds);
            retryMilliseconds = Math.min(retryMilliseconds * 2, diagnosticMaximumRetryMilliseconds);
          }
        });
    };
    timeout = setTimeout(poll, diagnosticPollIntervalMilliseconds);
    return () => {
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [diagnosticHistory?.activeRunId, resolvedDiagnosticsClient]);

  const value = useMemo<EventsContextValue>(
    () => ({
      clearLocal: () => setBuffer((current) => clearLocalEvents(current)),
      clearSupportBundlePreview: () => {
        setSupportBundlePreview(null);
        setSupportBundleResult("idle");
      },
      cancelDiagnosticRun: async (runId) => {
        const request = ++diagnosticRequest.current;
        setDiagnosticPending(true);
        try {
          const history = await resolvedDiagnosticsClient.cancelRun(runId);
          if (request === diagnosticRequest.current) {
            setDiagnosticHistory(history);
            setDiagnosticError(null);
          }
        } catch {
          if (request === diagnosticRequest.current) {
            setDiagnosticError("The diagnostic run could not be cancelled.");
          }
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
      previewSupportBundle: async () => {
        if (resolvedSupportBundleClient.availability !== "supported") return;
        setSupportBundlePending(true);
        setSupportBundleResult("idle");
        try {
          setSupportBundlePreview(await resolvedSupportBundleClient.preview());
        } catch {
          setSupportBundlePreview(null);
          setSupportBundleResult("failed");
        } finally {
          setSupportBundlePending(false);
        }
      },
      saveSupportBundle: async (previewId) => {
        setSupportBundlePending(true);
        try {
          const result = await resolvedSupportBundleClient.save(previewId);
          setSupportBundlePreview(null);
          setSupportBundleResult(result.status);
        } catch {
          setSupportBundlePreview(null);
          setSupportBundleResult("failed");
        } finally {
          setSupportBundlePending(false);
        }
      },
      startDiagnosticRun: async () => {
        const request = ++diagnosticRequest.current;
        setDiagnosticPending(true);
        try {
          const history = await resolvedDiagnosticsClient.startRun();
          if (request === diagnosticRequest.current) {
            setDiagnosticHistory(history);
            setDiagnosticError(null);
          }
        } catch {
          if (request === diagnosticRequest.current) {
            setDiagnosticError("The diagnostic run could not be started.");
          }
        } finally {
          setDiagnosticPending(false);
        }
      },
      supportBundleAvailability: resolvedSupportBundleClient.availability,
      supportBundlePending,
      supportBundlePreview,
      supportBundleResult,
    }),
    [
      buffer.events,
      connection,
      diagnosticError,
      diagnosticHistory,
      diagnosticPending,
      error,
      resolvedDiagnosticsClient,
      resolvedSupportBundleClient,
      snapshot,
      supportBundlePending,
      supportBundlePreview,
      supportBundleResult,
    ],
  );

  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEvents() {
  const context = useContext(EventsContext);
  if (!context) throw new Error("useEvents must be used inside EventsProvider");
  return context;
}

export function useOptionalEvents() {
  return useContext(EventsContext);
}
