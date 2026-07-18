import type {
  TrafficClient,
  TrafficConnectionState,
  TrafficDataSnapshotDto,
} from "@mish/contracts";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createFixtureTrafficClient } from "./fixture-traffic-client";
import {
  clearClosedHistory,
  createTrafficHistoryState,
  reconcileTrafficSnapshot,
  type ClosedTrafficConnection,
} from "../pages/traffic-model";

interface TrafficContextValue {
  clearClosed(): void;
  closed: ClosedTrafficConnection[];
  connection: TrafficConnectionState;
  error: string | null;
  isCurrent: boolean;
  isLoading: boolean;
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

  useEffect(() => {
    const controller = new AbortController();
    const acceptSnapshot = (nextSnapshot: TrafficDataSnapshotDto) => {
      setSnapshot(nextSnapshot);
      setHistory((current) => reconcileTrafficSnapshot(current, nextSnapshot));
      setError(null);
    };
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
  }, [resolvedClient]);

  const value = useMemo<TrafficContextValue>(
    () => ({
      clearClosed: () => setHistory((current) => clearClosedHistory(current)),
      closed: history.closed,
      connection,
      error,
      isCurrent: snapshot?.phase === "ready" && !connection.stale,
      isLoading: snapshot === null && error === null,
      snapshot,
    }),
    [connection, error, history.closed, snapshot],
  );

  return <TrafficContext.Provider value={value}>{children}</TrafficContext.Provider>;
}

export function useTraffic() {
  const context = useContext(TrafficContext);
  if (!context) throw new Error("useTraffic must be used inside TrafficProvider");
  return context;
}
