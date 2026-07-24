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
  const [commandFailure, setCommandFailure] = useState<TrafficCommandFailure | null>(null);
  const [isCloseAllPending, setCloseAllPending] = useState(false);
  const [isCloseFilteredVisiblePending, setCloseFilteredVisiblePending] = useState(false);
  const [pendingConnectionIds, setPendingConnectionIds] = useState<Set<string>>(() => new Set());
  const closeAllPendingRef = useRef(false);
  const closeFilteredVisiblePendingRef = useRef(false);
  const pendingConnectionIdsRef = useRef(new Set<string>());
  const processIconCacheRef = useRef(new Map<string, string>());
  const processIconRequestsRef = useRef(new Map<string, Promise<string | null>>());

  const acceptSnapshot = useCallback((nextSnapshot: TrafficDataSnapshotDto) => {
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
  }, []);

  useEffect(() => {
    processIconCacheRef.current.clear();
    processIconRequestsRef.current.clear();
    const controller = new AbortController();
    const unsubscribeConnection = resolvedClient.subscribeConnection((nextConnection) => {
      setConnection(nextConnection);
      if (!nextConnection.stale) return;
      setHistory((current) => ({ ...current, baseline: null }));
      // A transport gap invalidates the observation session boundary. Do not leave
      // a paused capture looking current through reconnect or runtime replacement.
      setPausedView(null);
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
      isCloseConnectionPending: (connectionId) => pendingConnectionIds.has(connectionId),
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
      connection,
      error,
      closed,
      getProcessIcon,
      isCloseAllPending,
      isCloseFilteredVisiblePending,
      pendingConnectionIds,
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
