import {
  StatusClientError,
  type CaptureRecoveryAction,
  type CaptureSelectionDto,
  type LocalProxyTestResultDto,
  type RoutingMode,
  type ServiceMonitorDraft,
  type StatusClient,
  type StatusCommand,
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
import {
  ApplicationSnapshotAcceptance,
  type SnapshotDelivery,
} from "./application-snapshot-acceptance";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";
import { createFixtureStatusClient } from "./fixture-status-client";

export type ProductCommand = StatusCommand;

export type ProductCommandState =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "success" }
  | { error: StatusClientError; phase: "failure" };

export type ProductCommandResult = { ok: true } | { error: StatusClientError; ok: false };

export type LocalProxyTestState =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "success"; result: LocalProxyTestResultDto }
  | { error: StatusClientError; phase: "failure" };

type ServiceProbeCommandState =
  | { phase: "pending" | "success" }
  | { phase: "failure"; previousObservedAt: string | null };

interface ProductContextValue {
  commandStates: Record<ProductCommand, ProductCommandState>;
  connection: StatusConnectionState;
  error: string | null;
  isCommandPending(command: ProductCommand): boolean;
  isGroupCommandPending(groupId: string): boolean;
  hasServiceProbeFailed(monitorId: string): boolean;
  isServiceProbePending(monitorId: string): boolean;
  isCommandSupported(command: ProductCommand): boolean;
  isLoading: boolean;
  localProxyTest: LocalProxyTestState;
  cancelGroupDelayTest(testId: string): Promise<ProductCommandResult>;
  removeServiceMonitor(monitorId: string): Promise<ProductCommandResult>;
  recoverSystemProxy(action: CaptureRecoveryAction): Promise<ProductCommandResult>;
  restoreDefaultServices(): Promise<ProductCommandResult>;
  selectGroupChild(groupId: string, childId: string): Promise<ProductCommandResult>;
  startGroupDelayTest(groupId: string): Promise<ProductCommandResult>;
  testServiceMonitor(monitorId: string): Promise<ProductCommandResult>;
  testLocalProxy(): Promise<LocalProxyTestResultDto | null>;
  setActiveProfile(profileId: string): Promise<ProductCommandResult>;
  setCapture(
    selection: CaptureSelectionDto,
    active: boolean,
    profileId?: string,
  ): Promise<ProductCommandResult>;
  setRoutingMode(mode: RoutingMode): Promise<ProductCommandResult>;
  setServiceProbeInterval(
    intervalSeconds: StatusSnapshotDto["serviceProbePolicy"]["intervalSeconds"],
  ): Promise<ProductCommandResult>;
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
    "group-delay": { phase: "idle" },
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

function commandErrorMessage(
  LL: TranslationFunctions,
  commandStates: Record<ProductCommand, ProductCommandState>,
) {
  const failure = Object.values(commandStates).find((state) => state.phase === "failure");
  if (!failure || failure.phase !== "failure") return LL.errors.command();
  switch (failure.error.code) {
    case "disconnected":
    case "runtime-replaced":
      return LL.errors.commandDisconnected();
    case "inconsistent-observation":
    case "validation":
      return LL.errors.commandInconsistent();
    case "stale-membership":
    case "not-found":
      return LL.errors.commandStaleMembership();
    case "timeout":
      return LL.errors.commandTimeout();
    case "unsupported":
    case "invalid-request":
      return LL.errors.commandUnsupported();
    case "version-drift":
      return LL.errors.commandVersionDrift();
    default:
      return LL.errors.command();
  }
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
  const [serviceProbeStates, setServiceProbeStates] = useState<
    Record<string, ServiceProbeCommandState>
  >({});
  const [localProxyTest, setLocalProxyTest] = useState<LocalProxyTestState>({ phase: "idle" });
  const pendingCommands = useRef(new Set<ProductCommand>());
  const commandControllers = useRef(new Map<string, AbortController>());
  const snapshotRef = useRef<StatusSnapshotDto | null>(null);
  const snapshotAcceptance = useRef(new ApplicationSnapshotAcceptance<StatusSnapshotDto>());
  const localProxyAuthority = snapshot
    ? JSON.stringify([snapshot.activeProfileId, snapshot.runtime.phase])
    : null;
  const localProxyAuthorityRef = useRef<string | null>(null);
  const acceptSnapshot = useCallback(
    (nextSnapshot: StatusSnapshotDto, delivery: SnapshotDelivery) => {
      const result = snapshotAcceptance.current.accept(nextSnapshot, delivery);
      if (result.kind === "stale" || result.kind === "duplicate") return false;
      if (result.kind === "conflict") {
        setLoadFailed(true);
        return false;
      }
      snapshotRef.current = result.snapshot;
      setSnapshot(result.snapshot);
      setLoadFailed(false);
      return true;
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    localProxyAuthorityRef.current = null;
    snapshotRef.current = null;
    snapshotAcceptance.current.clear();
    setLocalProxyTest({ phase: "idle" });
    setServiceProbeStates({});
    setConnection(resolvedClient.getConnectionState());
    const unsubscribeConnection = resolvedClient.subscribeConnection(setConnection);
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots((nextSnapshot, delivery) => {
      acceptSnapshot(nextSnapshot, delivery ?? "update");
    });

    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then((nextSnapshot) => {
        acceptSnapshot(nextSnapshot, "request");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
      });

    return () => {
      controller.abort();
      for (const commandController of commandControllers.current.values()) {
        commandController.abort();
      }
      commandControllers.current.clear();
      unsubscribeConnection();
      unsubscribeSnapshots();
    };
  }, [acceptSnapshot, resolvedClient]);

  useEffect(() => {
    const previousAuthority = localProxyAuthorityRef.current;
    localProxyAuthorityRef.current = localProxyAuthority;
    if (previousAuthority === null || previousAuthority === localProxyAuthority) return;

    const controller = commandControllers.current.get("local-proxy");
    controller?.abort();
    if (controller) commandControllers.current.delete("local-proxy");
    setLocalProxyTest({ phase: "idle" });
  }, [localProxyAuthority]);

  useEffect(() => {
    if (!snapshot) return;
    setServiceProbeStates((states) => {
      const recoveredMonitorIds = Object.entries(states).flatMap(([monitorId, state]) => {
        if (state.phase !== "failure") return [];
        const result = snapshot.probeResults.find(
          (candidate) => candidate.monitorId === monitorId && candidate.status !== "pending",
        );
        return result && result.observedAt !== state.previousObservedAt ? [monitorId] : [];
      });
      if (recoveredMonitorIds.length === 0) return states;
      const nextStates = { ...states };
      for (const monitorId of recoveredMonitorIds) delete nextStates[monitorId];
      return nextStates;
    });
  }, [snapshot]);

  const runCommand = useCallback(
    async (
      command: ProductCommand,
      operation: (signal: AbortSignal) => Promise<StatusSnapshotDto>,
      deduplicationKey: string = command,
    ) => {
      if (!resolvedClient.supportsCommand(command)) {
        return {
          error: new StatusClientError(
            "invalid-request",
            "This command is not supported by the current Status client",
          ),
          ok: false,
        } satisfies ProductCommandResult;
      }

      if (commandControllers.current.has(deduplicationKey)) {
        return {
          error: new StatusClientError("conflict", "This command is already pending", true),
          ok: false,
        } satisfies ProductCommandResult;
      }

      pendingCommands.current.add(command);
      const controller = new AbortController();
      commandControllers.current.set(deduplicationKey, controller);
      setCommandFailed(false);
      setCommandStates((states) => ({ ...states, [command]: { phase: "pending" } }));
      try {
        const nextSnapshot = await operation(controller.signal);
        acceptSnapshot(nextSnapshot, "command");
        setCommandStates((states) => ({ ...states, [command]: { phase: "success" } }));
        return { ok: true } satisfies ProductCommandResult;
      } catch (error) {
        const typedError = toStatusClientError(error);
        setCommandFailed(true);
        setCommandStates((states) => ({
          ...states,
          [command]: { error: typedError, phase: "failure" },
        }));
        try {
          const nextSnapshot = await resolvedClient.getSnapshot();
          acceptSnapshot(nextSnapshot, "request");
        } catch {
          // Keep the last confirmed snapshot stale when refresh also fails.
        }
        return { error: typedError, ok: false } satisfies ProductCommandResult;
      } finally {
        commandControllers.current.delete(deduplicationKey);
        if (![...commandControllers.current.keys()].some((key) => key.startsWith(command))) {
          pendingCommands.current.delete(command);
        }
      }
    },
    [acceptSnapshot, resolvedClient],
  );

  const testLocalProxy = useCallback(async () => {
    const key = "local-proxy";
    if (commandControllers.current.has(key)) return null;
    const controller = new AbortController();
    commandControllers.current.set(key, controller);
    setLocalProxyTest({ phase: "pending" });
    try {
      const result = await resolvedClient.testLocalProxy({ signal: controller.signal });
      if (controller.signal.aborted) return null;
      setLocalProxyTest({ phase: "success", result });
      return result;
    } catch (error) {
      if (controller.signal.aborted) return null;
      setLocalProxyTest({ error: toStatusClientError(error), phase: "failure" });
      return null;
    } finally {
      if (commandControllers.current.get(key) === controller) {
        commandControllers.current.delete(key);
      }
    }
  }, [resolvedClient]);

  const testServiceMonitor = useCallback(
    async (monitorId: string) => {
      if (!resolvedClient.supportsCommand("services")) {
        return {
          error: new StatusClientError(
            "invalid-request",
            "Service probes are not supported by the current Status client",
          ),
          ok: false,
        } satisfies ProductCommandResult;
      }

      const key = `services:probe:${monitorId}`;
      if (commandControllers.current.has(key)) {
        return {
          error: new StatusClientError("conflict", "This service probe is already pending", true),
          ok: false,
        } satisfies ProductCommandResult;
      }

      const controller = new AbortController();
      const previousObservedAt =
        snapshot?.probeResults.find((result) => result.monitorId === monitorId)?.observedAt ?? null;
      commandControllers.current.set(key, controller);
      setServiceProbeStates((states) => ({ ...states, [monitorId]: { phase: "pending" } }));
      try {
        const nextSnapshot = await resolvedClient.testServiceMonitor(monitorId, {
          signal: controller.signal,
        });
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
        setServiceProbeStates((states) => ({ ...states, [monitorId]: { phase: "success" } }));
        return { ok: true } satisfies ProductCommandResult;
      } catch (error) {
        const typedError = toStatusClientError(error);
        setServiceProbeStates((states) => {
          const hasNewConfirmedResult = snapshotRef.current?.probeResults.some(
            (result) =>
              result.monitorId === monitorId &&
              result.status !== "pending" &&
              result.observedAt !== previousObservedAt,
          );
          if (!hasNewConfirmedResult) {
            return { ...states, [monitorId]: { phase: "failure", previousObservedAt } };
          }
          const { [monitorId]: _discarded, ...remainingStates } = states;
          return remainingStates;
        });
        return { error: typedError, ok: false } satisfies ProductCommandResult;
      } finally {
        if (commandControllers.current.get(key) === controller) {
          commandControllers.current.delete(key);
        }
      }
    },
    [resolvedClient, snapshot],
  );

  const value = useMemo<ProductContextValue>(
    () => ({
      commandStates,
      connection,
      error: loadFailed
        ? LL.errors.loadStatus()
        : commandFailed
          ? commandErrorMessage(LL, commandStates)
          : null,
      isCommandPending: (command) =>
        commandStates[command].phase === "pending" ||
        (command === "capture" && snapshot?.runtime.captureOperation.phase === "pending"),
      isCommandSupported: (command) =>
        resolvedClient.supportsCommand(command) &&
        (connection.phase === "fixture" || !connection.stale),
      isGroupCommandPending: (groupId) => commandControllers.current.has(`group:${groupId}`),
      hasServiceProbeFailed: (monitorId) => serviceProbeStates[monitorId]?.phase === "failure",
      isServiceProbePending: (monitorId) => serviceProbeStates[monitorId]?.phase === "pending",
      isLoading: snapshot === null && !loadFailed,
      localProxyTest,
      cancelGroupDelayTest: (testId) =>
        runCommand(
          "group-delay",
          (signal) => resolvedClient.cancelGroupDelayTest(testId, { signal }),
          "group-delay:cancel",
        ),
      removeServiceMonitor: (monitorId) =>
        runCommand("services", (signal) =>
          resolvedClient.removeServiceMonitor(monitorId, { signal }),
        ),
      recoverSystemProxy: (action) =>
        runCommand("capture", (signal) => resolvedClient.recoverSystemProxy(action, { signal })),
      restoreDefaultServices: () =>
        runCommand("services", (signal) => resolvedClient.restoreDefaultServices({ signal })),
      selectGroupChild: (groupId, childId) =>
        runCommand(
          "group",
          (signal) => resolvedClient.selectGroupChild(groupId, childId, { signal }),
          `group:${groupId}`,
        ),
      startGroupDelayTest: (groupId) =>
        runCommand(
          "group-delay",
          (signal) => resolvedClient.startGroupDelayTest(groupId, { signal }),
          "group-delay:start",
        ),
      testServiceMonitor,
      testLocalProxy,
      setActiveProfile: (profileId) =>
        runCommand("profile", (signal) => resolvedClient.setActiveProfile(profileId, { signal })),
      setCapture: (selection, active, profileId) =>
        runCommand("capture", (signal) =>
          resolvedClient.setCapture(selection, active, profileId, { signal }),
        ),
      setRoutingMode: (mode) =>
        runCommand("routing", (signal) => resolvedClient.setRoutingMode(mode, { signal })),
      setServiceProbeInterval: (intervalSeconds) =>
        runCommand("services", (signal) =>
          resolvedClient.setServiceProbeInterval(intervalSeconds, { signal }),
        ),
      snapshot,
      upsertServiceMonitor: (draft) =>
        runCommand("services", (signal) => resolvedClient.upsertServiceMonitor(draft, { signal })),
    }),
    [
      LL,
      commandFailed,
      commandStates,
      connection,
      loadFailed,
      localProxyTest,
      resolvedClient,
      runCommand,
      serviceProbeStates,
      snapshot,
      testLocalProxy,
      testServiceMonitor,
    ],
  );

  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}

export function useProduct() {
  const context = useContext(ProductContext);
  if (!context) throw new Error("useProduct must be used inside ProductProvider");
  return context;
}
