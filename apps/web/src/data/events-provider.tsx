import type {
  EventsClient,
  EventsConnectionState,
  EventsSnapshotDto,
  SupportBundleClient,
  SupportBundlePreviewDto,
} from "@mish/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ApplicationSnapshotAcceptance,
  type SnapshotDelivery,
} from "./application-snapshot-acceptance";
import {
  applicationCommandAuthority,
  applicationCommandScope,
  useCommandFeedback,
  type CommandFeedbackOperation,
} from "./command-feedback";
import {
  clearLocalEvents,
  createEventsBufferState,
  reconcileEventsSnapshot,
} from "../pages/events-model";
import { createFixtureEventsClient } from "./fixture-events-client";
import { UnavailableSupportBundleClient } from "../platform/support-bundle";

type SupportBundleResult = "idle" | "cancelled" | "written" | "failed";

interface EventsContextValue {
  clearLocal(): void;
  connection: EventsConnectionState;
  error: string | null;
  events: ReturnType<typeof createEventsBufferState>["events"];
  isLoading: boolean;
  snapshot: EventsSnapshotDto | null;
  clearSupportBundlePreview(): void;
  previewSupportBundle(): Promise<void>;
  saveSupportBundle(previewId: string): Promise<void>;
  supportBundleAvailability: SupportBundleClient["availability"];
  supportBundlePending: boolean;
  supportBundlePreview: SupportBundlePreviewDto | null;
  supportBundleResult: SupportBundleResult;
}

const EventsContext = createContext<EventsContextValue | null>(null);

interface EventsProviderProps {
  children: ReactNode;
  client?: EventsClient;
  supportBundleClient?: SupportBundleClient;
}

interface EventsCommand {
  controller: AbortController;
  operation: CommandFeedbackOperation;
}

function eventsCommandScope(snapshot: EventsSnapshotDto | null) {
  return snapshot
    ? applicationCommandScope(snapshot.applicationOrder, "events")
    : "events:unconfirmed";
}

export function EventsProvider({ children, client, supportBundleClient }: EventsProviderProps) {
  const resolvedClient = useMemo(() => client ?? createFixtureEventsClient(), [client]);
  const resolvedSupportBundleClient = useMemo(
    () => supportBundleClient ?? new UnavailableSupportBundleClient(),
    [supportBundleClient],
  );
  const [snapshot, setSnapshot] = useState<EventsSnapshotDto | null>(null);
  const [connection, setConnection] = useState(() => resolvedClient.getConnectionState());
  const [buffer, setBuffer] = useState(createEventsBufferState);
  const [error, setError] = useState<string | null>(null);
  const {
    begin: beginCommandFeedback,
    isCurrent: isCurrentCommandFeedback,
    reset: resetCommandFeedback,
    resetPending: resetPendingCommandFeedback,
    state: commandFeedbackState,
    transition: transitionCommandFeedback,
  } = useCommandFeedback();
  const eventsCommands = useRef(new Map<string, EventsCommand>());
  const [supportBundlePreview, setSupportBundlePreview] = useState<SupportBundlePreviewDto | null>(
    null,
  );
  const [supportBundleResult, setSupportBundleResult] = useState<SupportBundleResult>("idle");
  const latestSnapshot = useRef<EventsSnapshotDto | null>(null);
  const snapshotAcceptance = useRef(new ApplicationSnapshotAcceptance<EventsSnapshotDto>());
  const reconcileCommandScopes = useCallback(
    (nextSnapshot: EventsSnapshotDto) => {
      const nextScope = eventsCommandScope(nextSnapshot);
      for (const command of eventsCommands.current.values()) {
        if (command.operation.scopeKey === nextScope) continue;
        command.controller.abort();
        transitionCommandFeedback(command.operation, "superseded");
      }
    },
    [transitionCommandFeedback],
  );
  const acceptSnapshot = useCallback(
    (nextSnapshot: EventsSnapshotDto, delivery: SnapshotDelivery) => {
      const result = snapshotAcceptance.current.accept(nextSnapshot, delivery);
      if (result.kind === "stale" || result.kind === "duplicate") return false;
      if (result.kind === "conflict") {
        setError("Events snapshot order conflict.");
        return false;
      }
      reconcileCommandScopes(result.snapshot);
      latestSnapshot.current = result.snapshot;
      setSnapshot(result.snapshot);
      setBuffer((current) => reconcileEventsSnapshot(current, result.snapshot));
      setError(null);
      return true;
    },
    [reconcileCommandScopes],
  );

  useEffect(() => {
    const controller = new AbortController();
    snapshotAcceptance.current.clear();
    latestSnapshot.current = null;
    resetCommandFeedback("cancelled");
    eventsCommands.current.clear();
    const unsubscribeConnection = resolvedClient.subscribeConnection((nextConnection) => {
      if (nextConnection.phase === "connected") {
        if (nextConnection.stale) snapshotAcceptance.current.armReconnect();
        else snapshotAcceptance.current.confirmReconnect();
      }
      if (
        nextConnection.phase !== "connected" &&
        nextConnection.phase !== "fixture" &&
        nextConnection.stale
      ) {
        for (const command of eventsCommands.current.values()) {
          command.controller.abort();
        }
        eventsCommands.current.clear();
        resetPendingCommandFeedback("disconnected");
      }
      setConnection(nextConnection);
    });
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots((nextSnapshot, delivery) =>
      acceptSnapshot(nextSnapshot, delivery ?? "update"),
    );
    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then((nextSnapshot) => acceptSnapshot(nextSnapshot, "request"))
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Events could not be loaded.");
      });

    return () => {
      controller.abort();
      for (const command of eventsCommands.current.values()) {
        command.controller.abort();
      }
      eventsCommands.current.clear();
      resetPendingCommandFeedback("cancelled");
      unsubscribeConnection();
      unsubscribeSnapshots();
    };
  }, [acceptSnapshot, resetCommandFeedback, resetPendingCommandFeedback, resolvedClient]);

  useEffect(
    () => () => {
      const command = eventsCommands.current.get("events:support-bundle");
      if (!command) return;
      command.controller.abort();
      transitionCommandFeedback(command.operation, "cancelled");
      eventsCommands.current.delete("events:support-bundle");
    },
    [resolvedSupportBundleClient, transitionCommandFeedback],
  );

  const beginEventsCommand = useCallback(
    (domainKey: string) => {
      const current = latestSnapshot.current;
      const operation = beginCommandFeedback({
        confirmedAuthority: current
          ? applicationCommandAuthority(current.applicationOrder)
          : undefined,
        domainKey,
        scopeKey: eventsCommandScope(current),
      });
      if (!operation) return null;
      const command = { controller: new AbortController(), operation };
      eventsCommands.current.set(domainKey, command);
      return command;
    },
    [beginCommandFeedback],
  );

  const finishEventsCommand = useCallback((command: EventsCommand) => {
    const current = eventsCommands.current.get(command.operation.domainKey);
    if (current?.operation.operationId === command.operation.operationId) {
      eventsCommands.current.delete(command.operation.domainKey);
    }
  }, []);

  const supportBundlePending =
    commandFeedbackState.operations.get("events:support-bundle")?.phase === "pending";

  const value = useMemo<EventsContextValue>(
    () => ({
      clearLocal: () => setBuffer((current) => clearLocalEvents(current)),
      clearSupportBundlePreview: () => {
        setSupportBundlePreview(null);
        setSupportBundleResult("idle");
      },
      connection,
      error,
      events: buffer.events,
      isLoading: snapshot === null && error === null,
      snapshot,
      previewSupportBundle: async () => {
        if (resolvedSupportBundleClient.availability !== "supported") return;
        const command = beginEventsCommand("events:support-bundle");
        if (!command) return;
        setSupportBundleResult("idle");
        try {
          const preview = await resolvedSupportBundleClient.preview({
            signal: command.controller.signal,
          });
          if (!isCurrentCommandFeedback(command.operation, "pending")) return;
          setSupportBundlePreview(preview);
          transitionCommandFeedback(command.operation, "success");
        } catch {
          if (isCurrentCommandFeedback(command.operation, "pending")) {
            setSupportBundlePreview(null);
            setSupportBundleResult("failed");
            transitionCommandFeedback(command.operation, "failure");
          }
        } finally {
          finishEventsCommand(command);
        }
      },
      saveSupportBundle: async (previewId) => {
        const command = beginEventsCommand("events:support-bundle");
        if (!command) return;
        try {
          const result = await resolvedSupportBundleClient.save(previewId, {
            signal: command.controller.signal,
          });
          if (!isCurrentCommandFeedback(command.operation, "pending")) return;
          setSupportBundlePreview(null);
          setSupportBundleResult(result.status);
          transitionCommandFeedback(
            command.operation,
            result.status === "written"
              ? "success"
              : result.status === "cancelled"
                ? "cancelled"
                : "failure",
          );
        } catch {
          if (isCurrentCommandFeedback(command.operation, "pending")) {
            setSupportBundlePreview(null);
            setSupportBundleResult("failed");
            transitionCommandFeedback(command.operation, "failure");
          }
        } finally {
          finishEventsCommand(command);
        }
      },
      supportBundleAvailability: resolvedSupportBundleClient.availability,
      supportBundlePending,
      supportBundlePreview,
      supportBundleResult,
    }),
    [
      beginEventsCommand,
      buffer.events,
      connection,
      error,
      finishEventsCommand,
      isCurrentCommandFeedback,
      resolvedSupportBundleClient,
      snapshot,
      supportBundlePending,
      supportBundlePreview,
      supportBundleResult,
      transitionCommandFeedback,
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
