import type {
  TrafficClient,
  TrafficCommandAuthorityDto,
  TrafficCommandFailure,
  TrafficCommandOperation,
  TrafficCommandResultDto,
  TrafficConnectionState,
  TrafficDataSnapshotDto,
  ApplicationSnapshotDelivery,
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
import { RpcSessionAuthority } from "@mish/rpc-client";
type SnapshotDelivery = ApplicationSnapshotDelivery | "command" | "request";
import {
  applicationCommandAuthority,
  applicationCommandScope,
  useCommandFeedback,
  type CommandFeedbackOperation,
} from "./command-feedback";
import { createFixtureTrafficClient } from "./fixture-traffic-client";
import {
  clearClosedHistory,
  createTrafficHistoryState,
  reconcileTrafficSnapshot,
  type ClosedTrafficConnection,
} from "../pages/traffic-model";

interface TrafficContextValue {
  authoritativeSnapshot: TrafficDataSnapshotDto | null;
  closeAllActive(): Promise<TrafficCommandResultDto | null>;
  closeConnection(connectionId: string): Promise<TrafficCommandResultDto | null>;
  closeFilteredVisible(
    authority: TrafficCommandAuthorityDto,
    connectionIds: string[],
  ): Promise<TrafficCommandResultDto | null>;
  clearClosed(): void;
  closed: ClosedTrafficConnection[];
  commandFailure: TrafficCommandFailure | null;
  connection: TrafficConnectionState;
  error: string | null;
  getProcessIcon(connectionId: string, processPath: string | null): Promise<string | null>;
  isCurrent: boolean;
  isLoading: boolean;
  isCloseAllPending: boolean;
  isCloseConnectionPending(connectionId: string): boolean;
  isCloseFilteredVisiblePending: boolean;
  isCommandSupported(command: TrafficCommandOperation): boolean;
  isViewPaused: boolean;
  pausedAt: Date | null;
  pausedUpdateCount: number;
  snapshot: TrafficDataSnapshotDto | null;
  toggleViewPause(): void;
}

const TrafficContext = createContext<TrafficContextValue | null>(null);

interface TrafficProviderProps {
  children: ReactNode;
  client?: TrafficClient;
}

interface TrafficCommand {
  controller: AbortController;
  operation: CommandFeedbackOperation;
}

interface TrafficFailurePayload {
  domainKey: string;
  failure: TrafficCommandFailure;
  operationId: string;
}

function trafficCommandScope(
  snapshot: TrafficDataSnapshotDto,
  authority: TrafficCommandAuthorityDto,
) {
  return applicationCommandScope(
    snapshot.applicationOrder,
    "traffic",
    authority.profileId,
    authority.sessionId,
  );
}

function trafficSnapshotScope(snapshot: TrafficDataSnapshotDto) {
  return applicationCommandScope(
    snapshot.applicationOrder,
    "traffic",
    snapshot.profileId,
    snapshot.sessionId ?? "",
  );
}

export function TrafficProvider({ children, client }: TrafficProviderProps) {
  const resolvedClient = useMemo(() => client ?? createFixtureTrafficClient(), [client]);
  // `latestSnapshot` is the sole Web-side copy of current RPC authority. The optional
  // capture is presentation-only and deliberately never feeds command authority.
  const [latestSnapshot, setLatestSnapshot] = useState<TrafficDataSnapshotDto | null>(null);
  const [pausedView, setPausedView] = useState<{
    capturedAt: Date;
    closed: ClosedTrafficConnection[];
    snapshot: TrafficDataSnapshotDto;
  } | null>(null);
  const [connection, setConnection] = useState(() => resolvedClient.getConnectionState());
  const [history, setHistory] = useState(createTrafficHistoryState);
  const [error, setError] = useState<string | null>(null);
  const [failurePayload, setFailurePayload] = useState<TrafficFailurePayload | null>(null);
  const {
    begin: beginCommandFeedback,
    cleanup: cleanupCommandFeedback,
    confirmAuthority: confirmCommandAuthority,
    isCurrent: isCurrentCommandFeedback,
    reset: resetCommandFeedback,
    resetPending: resetPendingCommandFeedback,
    state: commandFeedbackState,
    transition: transitionCommandFeedback,
  } = useCommandFeedback();
  const trafficCommands = useRef(new Map<string, TrafficCommand>());
  const latestTrafficOperation = useRef<CommandFeedbackOperation | null>(null);
  const processIconCacheRef = useRef(new Map<string, string>());
  const processIconRequestsRef = useRef(new Map<string, Promise<string | null>>());
  const latestSnapshotRef = useRef<TrafficDataSnapshotDto | null>(null);
  const sessionAuthority = useRef(new RpcSessionAuthority<TrafficDataSnapshotDto>());

  const reconcileCommandScopes = useCallback(
    (nextSnapshot: TrafficDataSnapshotDto, confirmAuthority: boolean) => {
      const nextScope = trafficSnapshotScope(nextSnapshot);
      for (const [domainKey, command] of trafficCommands.current) {
        const scopeReplaced = command.operation.scopeKey !== nextScope;
        const authorityConfirmed =
          !scopeReplaced &&
          confirmAuthority &&
          confirmCommandAuthority(
            command.operation,
            applicationCommandAuthority(nextSnapshot.applicationOrder),
          );
        if (!scopeReplaced && !authorityConfirmed) continue;
        command.controller.abort();
        if (scopeReplaced) transitionCommandFeedback(command.operation, "superseded");
        if (
          trafficCommands.current.get(domainKey)?.operation.operationId ===
          command.operation.operationId
        ) {
          trafficCommands.current.delete(domainKey);
        }
      }
    },
    [confirmCommandAuthority, transitionCommandFeedback],
  );

  const acceptSnapshot = useCallback(
    (nextSnapshot: TrafficDataSnapshotDto, delivery: SnapshotDelivery) => {
      if (delivery === "request" && sessionAuthority.current.getGeneration() === 0) {
        sessionAuthority.current.observeTransport(true);
      }
      const ticket =
        delivery === "baseline" || delivery === "update"
          ? sessionAuthority.current.beginSubscription()
          : sessionAuthority.current.beginRequest();
      const result = sessionAuthority.current.accept(ticket, nextSnapshot, delivery);
      if (result.kind === "stale" || result.kind === "duplicate") return false;
      if (result.kind === "conflict") {
        setError("Traffic snapshot order conflict.");
        return false;
      }
      if (!result.snapshot) return false;
      nextSnapshot = result.snapshot;
      reconcileCommandScopes(nextSnapshot, delivery !== "command");
      latestSnapshotRef.current = nextSnapshot;
      setLatestSnapshot(nextSnapshot);
      setPausedView((current) =>
        current &&
        (current.snapshot.profileId !== nextSnapshot.profileId ||
          current.snapshot.sessionId !== nextSnapshot.sessionId)
          ? null
          : current,
      );
      setHistory((current) => reconcileTrafficSnapshot(current, nextSnapshot));
      setError(null);
      return true;
    },
    [reconcileCommandScopes],
  );

  useEffect(() => {
    processIconCacheRef.current.clear();
    processIconRequestsRef.current.clear();
    sessionAuthority.current.clear();
    resetCommandFeedback("cancelled");
    trafficCommands.current.clear();
    latestTrafficOperation.current = null;
    setFailurePayload(null);
    const controller = new AbortController();
    const unsubscribeConnection = resolvedClient.subscribeConnection((nextConnection) => {
      sessionAuthority.current.observeTransport(
        nextConnection.phase === "connected" || nextConnection.phase === "fixture",
      );
      setConnection(nextConnection);
      if (!nextConnection.stale) return;
      for (const command of trafficCommands.current.values()) {
        command.controller.abort();
      }
      trafficCommands.current.clear();
      resetPendingCommandFeedback("disconnected");
      setHistory((current) => ({ ...current, baseline: null }));
      // A transport gap invalidates the observation session boundary. Do not leave
      // a paused capture looking current through reconnect or runtime replacement.
      setPausedView(null);
    });
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots((nextSnapshot, delivery) =>
      acceptSnapshot(nextSnapshot, delivery ?? "update"),
    );
    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then((nextSnapshot) => acceptSnapshot(nextSnapshot, "request"))
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Traffic data could not be loaded.");
      });

    return () => {
      controller.abort();
      for (const command of trafficCommands.current.values()) {
        command.controller.abort();
      }
      trafficCommands.current.clear();
      resetPendingCommandFeedback("cancelled");
      unsubscribeConnection();
      unsubscribeSnapshots();
    };
  }, [acceptSnapshot, resetCommandFeedback, resetPendingCommandFeedback, resolvedClient]);

  useEffect(() => {
    if (
      !pausedView ||
      !latestSnapshot ||
      (pausedView.snapshot.profileId === latestSnapshot.profileId &&
        pausedView.snapshot.sessionId === latestSnapshot.sessionId &&
        !connection.stale)
    ) {
      return;
    }
    setPausedView(null);
  }, [connection.stale, latestSnapshot, pausedView]);

  const snapshot = pausedView?.snapshot ?? latestSnapshot;
  const closed = pausedView?.closed ?? history.closed;
  const pausedUpdateCount =
    pausedView &&
    latestSnapshot?.profileId === pausedView.snapshot.profileId &&
    latestSnapshot.sessionId === pausedView.snapshot.sessionId
      ? Math.max(0, latestSnapshot.sequence - pausedView.snapshot.sequence)
      : 0;

  const toggleViewPause = useCallback(() => {
    setPausedView((current) => {
      if (current) return null;
      if (!latestSnapshot || latestSnapshot.phase !== "ready" || connection.stale) return null;
      return {
        capturedAt: new Date(),
        closed: structuredClone(history.closed),
        snapshot: structuredClone(latestSnapshot),
      };
    });
  }, [connection.stale, history.closed, latestSnapshot]);

  const commandAuthority = useCallback(() => {
    if (
      !latestSnapshot ||
      latestSnapshot.phase !== "ready" ||
      !latestSnapshot.sessionId ||
      connection.stale
    ) {
      return null;
    }
    return {
      profileId: latestSnapshot.profileId,
      sequence: latestSnapshot.sequence,
      sessionId: latestSnapshot.sessionId,
    };
  }, [connection.stale, latestSnapshot]);

  const beginTrafficCommand = useCallback(
    (domainKey: string, authority: TrafficCommandAuthorityDto) => {
      const currentSnapshot = latestSnapshotRef.current;
      if (!currentSnapshot) return null;
      const previous = latestTrafficOperation.current;
      if (previous) cleanupCommandFeedback(previous);
      const operation = beginCommandFeedback({
        confirmedAuthority: applicationCommandAuthority(currentSnapshot.applicationOrder),
        domainKey,
        scopeKey: trafficCommandScope(currentSnapshot, authority),
      });
      if (!operation) return null;
      const command = { controller: new AbortController(), operation };
      trafficCommands.current.set(domainKey, command);
      latestTrafficOperation.current = operation;
      setFailurePayload(null);
      return command;
    },
    [beginCommandFeedback, cleanupCommandFeedback],
  );

  const finishTrafficCommand = useCallback(
    (command: TrafficCommand) => {
      const current = trafficCommands.current.get(command.operation.domainKey);
      if (current?.operation.operationId === command.operation.operationId) {
        trafficCommands.current.delete(command.operation.domainKey);
      }
      if (latestTrafficOperation.current?.operationId !== command.operation.operationId) {
        cleanupCommandFeedback(command.operation);
      }
    },
    [cleanupCommandFeedback],
  );

  const publishTrafficFailure = useCallback(
    (command: TrafficCommand, failure: TrafficCommandFailure) => {
      if (!isCurrentCommandFeedback(command.operation, "pending")) return;
      if (latestTrafficOperation.current?.operationId === command.operation.operationId) {
        setFailurePayload({
          domainKey: command.operation.domainKey,
          failure,
          operationId: command.operation.operationId,
        });
      }
      transitionCommandFeedback(command.operation, "failure");
    },
    [isCurrentCommandFeedback, transitionCommandFeedback],
  );

  const closeAllActive = useCallback(async () => {
    const authority = commandAuthority();
    if (!authority || !resolvedClient.supportsCommand("close-all-active")) {
      return null;
    }
    const command = beginTrafficCommand("traffic:close-all", authority);
    if (!command) return null;
    try {
      const result = await resolvedClient.closeAllActive(authority, {
        signal: command.controller.signal,
      });
      if (!isCurrentCommandFeedback(command.operation, "pending")) return result;
      acceptSnapshot(result.snapshot, "command");
      if (result.failure) {
        publishTrafficFailure(command, result.failure);
      } else if (isCurrentCommandFeedback(command.operation, "pending")) {
        transitionCommandFeedback(command.operation, "success");
      }
      return result;
    } catch {
      if (!isCurrentCommandFeedback(command.operation, "pending")) return null;
      try {
        acceptSnapshot(
          await resolvedClient.getSnapshot({ signal: command.controller.signal }),
          "request",
        );
      } catch {
        // Retain the last authoritative snapshot when the refresh also fails.
      }
      publishTrafficFailure(command, "disconnected");
      return null;
    } finally {
      finishTrafficCommand(command);
    }
  }, [
    acceptSnapshot,
    beginTrafficCommand,
    commandAuthority,
    finishTrafficCommand,
    isCurrentCommandFeedback,
    publishTrafficFailure,
    resolvedClient,
    transitionCommandFeedback,
  ]);

  const closeConnection = useCallback(
    async (connectionId: string) => {
      const authority = commandAuthority();
      if (!authority || !resolvedClient.supportsCommand("close-connection")) {
        return null;
      }
      const command = beginTrafficCommand(`traffic:close:${connectionId}`, authority);
      if (!command) return null;
      try {
        const result = await resolvedClient.closeConnection(authority, connectionId, {
          signal: command.controller.signal,
        });
        if (!isCurrentCommandFeedback(command.operation, "pending")) return result;
        acceptSnapshot(result.snapshot, "command");
        if (result.failure) {
          publishTrafficFailure(command, result.failure);
        } else if (isCurrentCommandFeedback(command.operation, "pending")) {
          transitionCommandFeedback(command.operation, "success");
        }
        return result;
      } catch {
        if (!isCurrentCommandFeedback(command.operation, "pending")) return null;
        try {
          acceptSnapshot(
            await resolvedClient.getSnapshot({ signal: command.controller.signal }),
            "request",
          );
        } catch {
          // Retain the last authoritative snapshot when the refresh also fails.
        }
        publishTrafficFailure(command, "disconnected");
        return null;
      } finally {
        finishTrafficCommand(command);
      }
    },
    [
      acceptSnapshot,
      beginTrafficCommand,
      commandAuthority,
      finishTrafficCommand,
      isCurrentCommandFeedback,
      publishTrafficFailure,
      resolvedClient,
      transitionCommandFeedback,
    ],
  );

  const closeFilteredVisible = useCallback(
    async (authority: TrafficCommandAuthorityDto, connectionIds: string[]) => {
      if (connectionIds.length === 0 || !resolvedClient.supportsCommand("close-filtered-visible")) {
        return null;
      }
      const command = beginTrafficCommand("traffic:close-filtered", authority);
      if (!command) return null;
      try {
        const result = await resolvedClient.closeFilteredVisible(authority, connectionIds, {
          signal: command.controller.signal,
        });
        if (!isCurrentCommandFeedback(command.operation, "pending")) return result;
        acceptSnapshot(result.snapshot, "command");
        if (result.failure) {
          publishTrafficFailure(command, result.failure);
        } else if (isCurrentCommandFeedback(command.operation, "pending")) {
          transitionCommandFeedback(command.operation, "success");
        }
        return result;
      } catch {
        if (!isCurrentCommandFeedback(command.operation, "pending")) return null;
        try {
          acceptSnapshot(
            await resolvedClient.getSnapshot({ signal: command.controller.signal }),
            "request",
          );
        } catch {
          // Retain the last authoritative snapshot when the refresh also fails.
        }
        publishTrafficFailure(command, "disconnected");
        return null;
      } finally {
        finishTrafficCommand(command);
      }
    },
    [
      acceptSnapshot,
      beginTrafficCommand,
      finishTrafficCommand,
      isCurrentCommandFeedback,
      publishTrafficFailure,
      resolvedClient,
      transitionCommandFeedback,
    ],
  );

  const getProcessIcon = useCallback(
    (connectionId: string, processPath: string | null) => {
      if (!processPath) return Promise.resolve(null);
      const cached = processIconCacheRef.current.get(processPath);
      if (cached) return Promise.resolve(cached);
      const pending = processIconRequestsRef.current.get(processPath);
      if (pending) return pending;
      const request = resolvedClient
        .getProcessIcon(connectionId)
        .then(({ dataUrl }) => {
          if (!dataUrl) return null;
          if (processIconCacheRef.current.size >= 128) {
            const oldest = processIconCacheRef.current.keys().next().value;
            if (oldest) processIconCacheRef.current.delete(oldest);
          }
          processIconCacheRef.current.set(processPath, dataUrl);
          return dataUrl;
        })
        .catch(() => null)
        .finally(() => processIconRequestsRef.current.delete(processPath));
      processIconRequestsRef.current.set(processPath, request);
      return request;
    },
    [resolvedClient],
  );

  const latestFeedback = latestTrafficOperation.current
    ? commandFeedbackState.operations.get(latestTrafficOperation.current.domainKey)
    : undefined;
  const commandFailure =
    failurePayload &&
    latestFeedback?.operationId === failurePayload.operationId &&
    latestFeedback.domainKey === failurePayload.domainKey &&
    latestFeedback.phase === "failure"
      ? failurePayload.failure
      : latestFeedback?.phase === "disconnected"
        ? "disconnected"
        : null;
  const isCloseAllPending =
    commandFeedbackState.operations.get("traffic:close-all")?.phase === "pending";
  const isCloseFilteredVisiblePending =
    commandFeedbackState.operations.get("traffic:close-filtered")?.phase === "pending";

  const value = useMemo<TrafficContextValue>(
    () => ({
      authoritativeSnapshot: latestSnapshot,
      closeAllActive,
      closeConnection,
      closeFilteredVisible,
      clearClosed: () => setHistory((current) => clearClosedHistory(current)),
      closed,
      commandFailure,
      connection,
      error,
      getProcessIcon,
      isCurrent: snapshot?.phase === "ready" && !connection.stale,
      isLoading: latestSnapshot === null && error === null,
      isCloseAllPending,
      isCloseConnectionPending: (connectionId) =>
        commandFeedbackState.operations.get(`traffic:close:${connectionId}`)?.phase === "pending",
      isCloseFilteredVisiblePending,
      isCommandSupported: (command) =>
        latestSnapshot?.adapterKind === "rpc" &&
        latestSnapshot.phase === "ready" &&
        !connection.stale &&
        resolvedClient.supportsCommand(command),
      isViewPaused: pausedView !== null,
      pausedAt: pausedView?.capturedAt ?? null,
      pausedUpdateCount,
      snapshot,
      toggleViewPause,
    }),
    [
      closeAllActive,
      closeConnection,
      closeFilteredVisible,
      commandFailure,
      commandFeedbackState,
      connection,
      error,
      closed,
      getProcessIcon,
      isCloseAllPending,
      isCloseFilteredVisiblePending,
      resolvedClient,
      latestSnapshot,
      pausedUpdateCount,
      pausedView,
      snapshot,
      toggleViewPause,
    ],
  );

  return <TrafficContext.Provider value={value}>{children}</TrafficContext.Provider>;
}

export function useTraffic() {
  const context = useContext(TrafficContext);
  if (!context) throw new Error("useTraffic must be used inside TrafficProvider");
  return context;
}

export function useOptionalTraffic() {
  return useContext(TrafficContext);
}
