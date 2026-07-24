import type {
  TrafficClient,
  TrafficCommandAuthorityDto,
  TrafficCommandFailure,
  TrafficCommandOperation,
  TrafficCommandResultDto,
  TrafficConnectionState,
  TrafficDataSnapshotDto,
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
import { createFixtureTrafficClient } from "./fixture-traffic-client";
import {
  clearClosedHistory,
  createTrafficHistoryState,
  reconcileTrafficSnapshot,
  type ClosedTrafficConnection,
} from "../pages/traffic-model";

interface TrafficContextValue {
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
  isCurrent: boolean;
  isLoading: boolean;
  isCloseAllPending: boolean;
  isCloseConnectionPending(connectionId: string): boolean;
  isCloseFilteredVisiblePending: boolean;
  isCommandSupported(command: TrafficCommandOperation): boolean;
  snapshot: TrafficDataSnapshotDto | null;
}

const TrafficContext = createContext<TrafficContextValue | null>(null);

interface TrafficProviderProps {
  children: ReactNode;
  client?: TrafficClient;
}

export function TrafficProvider({ children, client }: TrafficProviderProps) {
  const resolvedClient = useMemo(() => client ?? createFixtureTrafficClient(), [client]);
  const [snapshot, setSnapshot] = useState<TrafficDataSnapshotDto | null>(null);
  const [connection, setConnection] = useState(() => resolvedClient.getConnectionState());
  const [history, setHistory] = useState(createTrafficHistoryState);
  const [error, setError] = useState<string | null>(null);
  const [commandFailure, setCommandFailure] = useState<TrafficCommandFailure | null>(null);
  const [isCloseAllPending, setCloseAllPending] = useState(false);
  const [isCloseFilteredVisiblePending, setCloseFilteredVisiblePending] = useState(false);
  const [pendingConnectionIds, setPendingConnectionIds] = useState<Set<string>>(() => new Set());
  const closeAllPendingRef = useRef(false);
  const closeFilteredVisiblePendingRef = useRef(false);
  const pendingConnectionIdsRef = useRef(new Set<string>());

  const acceptSnapshot = useCallback((nextSnapshot: TrafficDataSnapshotDto) => {
    setSnapshot(nextSnapshot);
    setHistory((current) => reconcileTrafficSnapshot(current, nextSnapshot));
    setError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const unsubscribeConnection = resolvedClient.subscribeConnection((nextConnection) => {
      setConnection(nextConnection);
      if (!nextConnection.stale) return;
      setHistory((current) => ({ ...current, baseline: null }));
    });
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots(acceptSnapshot);
    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then(acceptSnapshot)
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Traffic data could not be loaded.");
      });

    return () => {
      controller.abort();
      unsubscribeConnection();
      unsubscribeSnapshots();
    };
  }, [acceptSnapshot, resolvedClient]);

  const commandAuthority = useCallback(() => {
    if (!snapshot || snapshot.phase !== "ready" || !snapshot.sessionId || connection.stale) {
      return null;
    }
    return {
      profileId: snapshot.profileId,
      sequence: snapshot.sequence,
      sessionId: snapshot.sessionId,
    };
  }, [connection.stale, snapshot]);

  const closeAllActive = useCallback(async () => {
    const authority = commandAuthority();
    if (
      !authority ||
      closeAllPendingRef.current ||
      !resolvedClient.supportsCommand("close-all-active")
    ) {
      return null;
    }
    closeAllPendingRef.current = true;
    setCloseAllPending(true);
    setCommandFailure(null);
    try {
      const result = await resolvedClient.closeAllActive(authority);
      acceptSnapshot(result.snapshot);
      setCommandFailure(result.failure);
      return result;
    } catch {
      setCommandFailure("disconnected");
      try {
        acceptSnapshot(await resolvedClient.getSnapshot());
      } catch {
        // Retain the last authoritative snapshot when the refresh also fails.
      }
      return null;
    } finally {
      closeAllPendingRef.current = false;
      setCloseAllPending(false);
    }
  }, [acceptSnapshot, commandAuthority, resolvedClient]);

  const closeConnection = useCallback(
    async (connectionId: string) => {
      const authority = commandAuthority();
      if (
        !authority ||
        pendingConnectionIdsRef.current.has(connectionId) ||
        !resolvedClient.supportsCommand("close-connection")
      ) {
        return null;
      }
      pendingConnectionIdsRef.current.add(connectionId);
      setPendingConnectionIds((current) => new Set(current).add(connectionId));
      setCommandFailure(null);
      try {
        const result = await resolvedClient.closeConnection(authority, connectionId);
        acceptSnapshot(result.snapshot);
        setCommandFailure(result.failure);
        return result;
      } catch {
        setCommandFailure("disconnected");
        try {
          acceptSnapshot(await resolvedClient.getSnapshot());
        } catch {
          // Retain the last authoritative snapshot when the refresh also fails.
        }
        return null;
      } finally {
        pendingConnectionIdsRef.current.delete(connectionId);
        setPendingConnectionIds((current) => {
          const next = new Set(current);
          next.delete(connectionId);
          return next;
        });
      }
    },
    [acceptSnapshot, commandAuthority, resolvedClient],
  );

  const closeFilteredVisible = useCallback(
    async (authority: TrafficCommandAuthorityDto, connectionIds: string[]) => {
      if (
        connectionIds.length === 0 ||
        closeFilteredVisiblePendingRef.current ||
        !resolvedClient.supportsCommand("close-filtered-visible")
      ) {
        return null;
      }
      closeFilteredVisiblePendingRef.current = true;
      setCloseFilteredVisiblePending(true);
      setCommandFailure(null);
      try {
        const result = await resolvedClient.closeFilteredVisible(authority, connectionIds);
        acceptSnapshot(result.snapshot);
        setCommandFailure(result.failure);
        return result;
      } catch {
        setCommandFailure("disconnected");
        try {
          acceptSnapshot(await resolvedClient.getSnapshot());
        } catch {
          // Retain the last authoritative snapshot when the refresh also fails.
        }
        return null;
      } finally {
        closeFilteredVisiblePendingRef.current = false;
        setCloseFilteredVisiblePending(false);
      }
    },
    [acceptSnapshot, resolvedClient],
  );

  const value = useMemo<TrafficContextValue>(
    () => ({
      closeAllActive,
      closeConnection,
      closeFilteredVisible,
      clearClosed: () => setHistory((current) => clearClosedHistory(current)),
      closed: history.closed,
      commandFailure,
      connection,
      error,
      isCurrent: snapshot?.phase === "ready" && !connection.stale,
      isLoading: snapshot === null && error === null,
      isCloseAllPending,
      isCloseConnectionPending: (connectionId) => pendingConnectionIds.has(connectionId),
      isCloseFilteredVisiblePending,
      isCommandSupported: (command) =>
        snapshot?.adapterKind === "rpc" &&
        snapshot.phase === "ready" &&
        !connection.stale &&
        resolvedClient.supportsCommand(command),
      snapshot,
    }),
    [
      closeAllActive,
      closeConnection,
      closeFilteredVisible,
      commandFailure,
      connection,
      error,
      history.closed,
      isCloseAllPending,
      isCloseFilteredVisiblePending,
      pendingConnectionIds,
      resolvedClient,
      snapshot,
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
