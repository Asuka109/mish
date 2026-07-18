import {
  StatusClientError,
  type RoutingMode,
  type ServiceMonitorDraft,
  type StatusClient,
  type StatusConnectionState,
  type StatusSnapshotDto,
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
import { useI18nContext } from "../i18n/i18n-react";
import { createFixtureStatusClient } from "./fixture-status-client";

export type ProductCommand = "capture" | "group" | "profile" | "routing" | "services";

export type ProductCommandState =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "success" }
  | { error: StatusClientError; phase: "failure" };

export type ProductCommandResult = { ok: true } | { error: StatusClientError; ok: false };

interface ProductContextValue {
  commandStates: Record<ProductCommand, ProductCommandState>;
  connection: StatusConnectionState;
  error: string | null;
  isCommandPending(command: ProductCommand): boolean;
  isLoading: boolean;
  removeServiceMonitor(monitorId: string): Promise<ProductCommandResult>;
  restoreDefaultServices(): Promise<ProductCommandResult>;
  selectGroupChild(groupId: string, childId: string): Promise<ProductCommandResult>;
  setActiveProfile(profileId: string): Promise<ProductCommandResult>;
  setCapture(systemProxyEnabled: boolean, tunEnabled: boolean): Promise<ProductCommandResult>;
  setRoutingMode(mode: RoutingMode): Promise<ProductCommandResult>;
  snapshot: StatusSnapshotDto | null;
  upsertServiceMonitor(draft: ServiceMonitorDraft): Promise<ProductCommandResult>;
}

const ProductContext = createContext<ProductContextValue | null>(null);

interface ProductProviderProps {
  children: ReactNode;
  client?: StatusClient;
}

function createInitialCommandStates(): Record<ProductCommand, ProductCommandState> {
  return {
    capture: { phase: "idle" },
    group: { phase: "idle" },
    profile: { phase: "idle" },
    routing: { phase: "idle" },
    services: { phase: "idle" },
  };
}

function toStatusClientError(error: unknown) {
  if (error instanceof StatusClientError) return error;
  if (error instanceof Error) return new StatusClientError("unknown", error.message);
  return new StatusClientError("unknown", "Unknown Status client failure");
}

export function ProductProvider({ children, client }: ProductProviderProps) {
  const { LL } = useI18nContext();
  const resolvedClient = useMemo(() => client ?? createFixtureStatusClient(), [client]);
  const [snapshot, setSnapshot] = useState<StatusSnapshotDto | null>(null);
  const [connection, setConnection] = useState<StatusConnectionState>(() =>
    resolvedClient.getConnectionState(),
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [commandFailed, setCommandFailed] = useState(false);
  const [commandStates, setCommandStates] = useState(createInitialCommandStates);
  const pendingCommands = useRef(new Set<ProductCommand>());

  useEffect(() => {
    const controller = new AbortController();
    setConnection(resolvedClient.getConnectionState());
    const unsubscribeConnection = resolvedClient.subscribeConnection(setConnection);
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setLoadFailed(false);
    });

    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setLoadFailed(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
      });

    return () => {
      controller.abort();
      unsubscribeConnection();
      unsubscribeSnapshots();
    };
  }, [resolvedClient]);

  const runCommand = useCallback(
    async (command: ProductCommand, operation: () => Promise<StatusSnapshotDto>) => {
      if (pendingCommands.current.has(command)) {
        return {
          error: new StatusClientError("conflict", "This command is already pending", true),
          ok: false,
        } satisfies ProductCommandResult;
      }

      pendingCommands.current.add(command);
      setCommandFailed(false);
      setCommandStates((states) => ({ ...states, [command]: { phase: "pending" } }));
      try {
        setSnapshot(await operation());
        setCommandStates((states) => ({ ...states, [command]: { phase: "success" } }));
        return { ok: true } satisfies ProductCommandResult;
      } catch (error) {
        const typedError = toStatusClientError(error);
        setCommandFailed(true);
        setCommandStates((states) => ({
          ...states,
          [command]: { error: typedError, phase: "failure" },
        }));
        return { error: typedError, ok: false } satisfies ProductCommandResult;
      } finally {
        pendingCommands.current.delete(command);
      }
    },
    [],
  );

  const value = useMemo<ProductContextValue>(
    () => ({
      commandStates,
      connection,
      error: loadFailed ? LL.errors.loadStatus() : commandFailed ? LL.errors.command() : null,
      isCommandPending: (command) => commandStates[command].phase === "pending",
      isLoading: snapshot === null && !loadFailed,
      removeServiceMonitor: (monitorId) =>
        runCommand("services", () => resolvedClient.removeServiceMonitor(monitorId)),
      restoreDefaultServices: () =>
        runCommand("services", () => resolvedClient.restoreDefaultServices()),
      selectGroupChild: (groupId, childId) =>
        runCommand("group", () => resolvedClient.selectGroupChild(groupId, childId)),
      setActiveProfile: (profileId) =>
        runCommand("profile", () => resolvedClient.setActiveProfile(profileId)),
      setCapture: (systemProxyEnabled, tunEnabled) =>
        runCommand("capture", () => resolvedClient.setCapture(systemProxyEnabled, tunEnabled)),
      setRoutingMode: (mode) => runCommand("routing", () => resolvedClient.setRoutingMode(mode)),
      snapshot,
      upsertServiceMonitor: (draft) =>
        runCommand("services", () => resolvedClient.upsertServiceMonitor(draft)),
    }),
    [
      LL,
      commandFailed,
      commandStates,
      connection,
      loadFailed,
      resolvedClient,
      runCommand,
      snapshot,
    ],
  );

  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}

export function useProduct() {
  const context = useContext(ProductContext);
  if (!context) throw new Error("useProduct must be used inside ProductProvider");
  return context;
}
