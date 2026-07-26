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
import {
  applicationCommandAuthority,
  applicationCommandScope,
  captureCommandAuthority,
  captureCommandScope,
  useCommandFeedback,
  type CommandFeedbackOperation,
} from "./command-feedback";
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

interface ProductCommandFailurePayload {
  error: StatusClientError;
  operationId: string;
}

interface ServiceProbeFailurePayload {
  operationId: string;
  previousObservedAt: string | null;
}

interface ProductCommandController {
  command: ProductCommand | "local-proxy";
  controller: AbortController;
  operation: CommandFeedbackOperation;
}

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
  setCapture(selection: CaptureSelectionDto, active: boolean): Promise<ProductCommandResult>;
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

function productCommandDomain(deduplicationKey: string) {
  return `product:${deduplicationKey}`;
}

function productCommandScope(snapshot: StatusSnapshotDto, command: ProductCommand) {
  return command === "capture"
    ? captureCommandScope(snapshot.applicationOrder, snapshot.runtime.captureOperation)
    : applicationCommandScope(snapshot.applicationOrder, "product", command);
}

function productCommandAuthority(snapshot: StatusSnapshotDto, command: ProductCommand) {
  return command === "capture"
    ? captureCommandAuthority(snapshot.applicationOrder, snapshot.runtime.captureOperation)
    : applicationCommandAuthority(snapshot.applicationOrder);
}

function localProxyCommandScope(snapshot: StatusSnapshotDto | null) {
  return snapshot
    ? applicationCommandScope(
        snapshot.applicationOrder,
        "local-proxy",
        snapshot.activeProfileId,
        snapshot.runtime.phase,
      )
    : "local-proxy:unconfirmed";
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
  const [commandFailures, setCommandFailures] = useState<
    Record<string, ProductCommandFailurePayload>
  >({});
  const [serviceProbeFailures, setServiceProbeFailures] = useState<
    Record<string, ServiceProbeFailurePayload>
  >({});
  const [localProxyPayload, setLocalProxyPayload] = useState<
    | { error: StatusClientError; operationId: string }
    | { operationId: string; result: LocalProxyTestResultDto }
    | null
  >(null);
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
  const commandControllers = useRef(new Map<string, ProductCommandController>());
  const commandDomains = useRef(new Map<string, ProductCommand>());
  const snapshotRef = useRef<StatusSnapshotDto | null>(null);
  const snapshotAcceptance = useRef(new ApplicationSnapshotAcceptance<StatusSnapshotDto>());
  const localProxyAuthority = snapshot
    ? JSON.stringify([snapshot.activeProfileId, snapshot.runtime.phase])
    : null;
  const localProxyAuthorityRef = useRef<string | null>(null);
  const reconcileCommandFeedback = useCallback(
    (nextSnapshot: StatusSnapshotDto, confirmAuthority: boolean) => {
      for (const [key, entry] of commandControllers.current) {
        const { command, operation } = entry;
        if (command === "local-proxy") {
          if (operation.scopeKey !== localProxyCommandScope(nextSnapshot)) {
            entry.controller.abort();
            transitionCommandFeedback(operation, "superseded");
            commandControllers.current.delete(key);
          }
          continue;
        }
        const scopeKey = productCommandScope(nextSnapshot, command);
        if (operation.scopeKey !== scopeKey) {
          entry.controller.abort();
          transitionCommandFeedback(operation, "superseded");
          commandControllers.current.delete(key);
          continue;
        }
        if (!confirmAuthority) continue;
        if (confirmCommandAuthority(operation, productCommandAuthority(nextSnapshot, command))) {
          entry.controller.abort();
          commandControllers.current.delete(key);
        }
      }
    },
    [confirmCommandAuthority, transitionCommandFeedback],
  );
  const acceptSnapshot = useCallback(
    (nextSnapshot: StatusSnapshotDto, delivery: SnapshotDelivery) => {
      const result = snapshotAcceptance.current.accept(nextSnapshot, delivery);
      if (result.kind === "stale" || result.kind === "duplicate") return false;
      if (result.kind === "conflict") {
        setLoadFailed(true);
        return false;
      }
      reconcileCommandFeedback(result.snapshot, delivery !== "command");
      snapshotRef.current = result.snapshot;
      setSnapshot(result.snapshot);
      setLoadFailed(false);
      return true;
    },
    [reconcileCommandFeedback],
  );

  useEffect(() => {
    const controller = new AbortController();
    localProxyAuthorityRef.current = null;
    snapshotRef.current = null;
    snapshotAcceptance.current.clear();
    resetCommandFeedback("cancelled");
    commandDomains.current.clear();
    setCommandFailures({});
    setLocalProxyPayload(null);
    setServiceProbeFailures({});
    setConnection(resolvedClient.getConnectionState());
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
        for (const entry of commandControllers.current.values()) {
          entry.controller.abort();
        }
        commandControllers.current.clear();
        resetPendingCommandFeedback("disconnected");
      }
      setConnection(nextConnection);
    });
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
      for (const entry of commandControllers.current.values()) {
        entry.controller.abort();
      }
      resetPendingCommandFeedback("cancelled");
      commandControllers.current.clear();
      unsubscribeConnection();
      unsubscribeSnapshots();
    };
  }, [acceptSnapshot, resetCommandFeedback, resetPendingCommandFeedback, resolvedClient]);

  useEffect(() => {
    const previousAuthority = localProxyAuthorityRef.current;
    localProxyAuthorityRef.current = localProxyAuthority;
    if (previousAuthority === null || previousAuthority === localProxyAuthority) return;

    const entry = commandControllers.current.get("local-proxy");
    entry?.controller.abort();
    if (entry) {
      transitionCommandFeedback(entry.operation, "superseded");
      cleanupCommandFeedback(entry.operation);
      commandControllers.current.delete("local-proxy");
    }
    setLocalProxyPayload(null);
  }, [cleanupCommandFeedback, localProxyAuthority, transitionCommandFeedback]);

  useEffect(() => {
    if (!snapshot) return;
    const recoveredMonitorIds = Object.entries(serviceProbeFailures).flatMap(
      ([monitorId, failure]) => {
        const result = snapshot.probeResults.find(
          (candidate) => candidate.monitorId === monitorId && candidate.status !== "pending",
        );
        return result && result.observedAt !== failure.previousObservedAt ? [monitorId] : [];
      },
    );
    if (recoveredMonitorIds.length === 0) return;
    for (const monitorId of recoveredMonitorIds) {
      const failure = serviceProbeFailures[monitorId];
      const operation = commandFeedbackState.operations.get(
        productCommandDomain(`services:probe:${monitorId}`),
      );
      if (failure && operation?.operationId === failure.operationId) {
        cleanupCommandFeedback(operation);
      }
    }
    setServiceProbeFailures((current) => {
      const next = { ...current };
      for (const monitorId of recoveredMonitorIds) delete next[monitorId];
      return next;
    });
  }, [cleanupCommandFeedback, commandFeedbackState, serviceProbeFailures, snapshot]);

  const runCommand = useCallback(
    async (
      command: ProductCommand,
      execute: (signal: AbortSignal) => Promise<StatusSnapshotDto>,
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

      const currentSnapshot = snapshotRef.current;
      const domainKey = productCommandDomain(deduplicationKey);
      const feedbackOperation = beginCommandFeedback({
        confirmedAuthority: currentSnapshot
          ? productCommandAuthority(currentSnapshot, command)
          : undefined,
        domainKey,
        scopeKey: currentSnapshot
          ? productCommandScope(currentSnapshot, command)
          : "product:unconfirmed",
      });
      if (!feedbackOperation) {
        return {
          error: new StatusClientError("conflict", "This command is already pending", true),
          ok: false,
        } satisfies ProductCommandResult;
      }
      const controller = new AbortController();
      commandControllers.current.set(deduplicationKey, {
        command,
        controller,
        operation: feedbackOperation,
      });
      commandDomains.current.set(domainKey, command);
      setCommandFailures((current) => {
        if (!current[domainKey]) return current;
        const next = { ...current };
        delete next[domainKey];
        return next;
      });
      try {
        const nextSnapshot = await execute(controller.signal);
        if (!isCurrentCommandFeedback(feedbackOperation, "pending")) {
          return { ok: true } satisfies ProductCommandResult;
        }
        const accepted = acceptSnapshot(nextSnapshot, "command");
        if (isCurrentCommandFeedback(feedbackOperation, "pending")) {
          transitionCommandFeedback(feedbackOperation, accepted ? "success" : "superseded");
        }
        return { ok: true } satisfies ProductCommandResult;
      } catch (error) {
        const typedError = toStatusClientError(error);
        if (!isCurrentCommandFeedback(feedbackOperation, "pending")) {
          return { error: typedError, ok: false } satisfies ProductCommandResult;
        }
        if (typedError.snapshot !== null) {
          snapshotAcceptance.current.clear();
          acceptSnapshot(typedError.snapshot, "baseline");
        } else {
          try {
            const nextSnapshot = await resolvedClient.getSnapshot();
            acceptSnapshot(nextSnapshot, "request");
          } catch {
            // Keep the last confirmed snapshot stale when refresh also fails.
          }
        }
        if (isCurrentCommandFeedback(feedbackOperation, "pending")) {
          setCommandFailures((current) => ({
            ...current,
            [domainKey]: {
              error: typedError,
              operationId: feedbackOperation.operationId,
            },
          }));
          transitionCommandFeedback(feedbackOperation, "failure");
        }
        if (typedError.snapshot !== null) {
          return { error: typedError, ok: false } satisfies ProductCommandResult;
        }
        return { error: typedError, ok: false } satisfies ProductCommandResult;
      } finally {
        const current = commandControllers.current.get(deduplicationKey);
        if (current?.operation.operationId === feedbackOperation.operationId) {
          commandControllers.current.delete(deduplicationKey);
        }
      }
    },
    [
      acceptSnapshot,
      beginCommandFeedback,
      isCurrentCommandFeedback,
      resolvedClient,
      transitionCommandFeedback,
    ],
  );

  const testLocalProxy = useCallback(async () => {
    const key = "local-proxy";
    if (commandControllers.current.has(key)) return null;
    const feedbackOperation = beginCommandFeedback({
      domainKey: productCommandDomain(key),
      scopeKey: localProxyCommandScope(snapshotRef.current),
    });
    if (!feedbackOperation) return null;
    const controller = new AbortController();
    commandControllers.current.set(key, {
      command: "local-proxy",
      controller,
      operation: feedbackOperation,
    });
    setLocalProxyPayload(null);
    try {
      const result = await resolvedClient.testLocalProxy({ signal: controller.signal });
      if (!isCurrentCommandFeedback(feedbackOperation, "pending")) return null;
      setLocalProxyPayload({ operationId: feedbackOperation.operationId, result });
      transitionCommandFeedback(feedbackOperation, "success");
      return result;
    } catch (error) {
      if (!isCurrentCommandFeedback(feedbackOperation, "pending")) return null;
      setLocalProxyPayload({
        error: toStatusClientError(error),
        operationId: feedbackOperation.operationId,
      });
      transitionCommandFeedback(feedbackOperation, "failure");
      return null;
    } finally {
      if (
        commandControllers.current.get(key)?.operation.operationId === feedbackOperation.operationId
      ) {
        commandControllers.current.delete(key);
      }
    }
  }, [beginCommandFeedback, isCurrentCommandFeedback, resolvedClient, transitionCommandFeedback]);

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
      const currentSnapshot = snapshotRef.current;
      const previousObservedAt =
        currentSnapshot?.probeResults.find((result) => result.monitorId === monitorId)
          ?.observedAt ?? null;
      const domainKey = productCommandDomain(key);
      const feedbackOperation = beginCommandFeedback({
        confirmedAuthority: currentSnapshot
          ? productCommandAuthority(currentSnapshot, "services")
          : undefined,
        domainKey,
        scopeKey: currentSnapshot
          ? productCommandScope(currentSnapshot, "services")
          : "product:unconfirmed",
      });
      if (!feedbackOperation) {
        return {
          error: new StatusClientError("conflict", "This service probe is already pending", true),
          ok: false,
        } satisfies ProductCommandResult;
      }
      commandControllers.current.set(key, {
        command: "services",
        controller,
        operation: feedbackOperation,
      });
      setServiceProbeFailures((current) => {
        if (!current[monitorId]) return current;
        const next = { ...current };
        delete next[monitorId];
        return next;
      });
      try {
        const nextSnapshot = await resolvedClient.testServiceMonitor(monitorId, {
          signal: controller.signal,
        });
        if (!isCurrentCommandFeedback(feedbackOperation, "pending")) {
          return { ok: true } satisfies ProductCommandResult;
        }
        const accepted = acceptSnapshot(nextSnapshot, "command");
        if (isCurrentCommandFeedback(feedbackOperation, "pending")) {
          transitionCommandFeedback(feedbackOperation, accepted ? "success" : "superseded");
        }
        return { ok: true } satisfies ProductCommandResult;
      } catch (error) {
        const typedError = toStatusClientError(error);
        const hasNewConfirmedResult = snapshotRef.current?.probeResults.some(
          (result) =>
            result.monitorId === monitorId &&
            result.status !== "pending" &&
            result.observedAt !== previousObservedAt,
        );
        if (!hasNewConfirmedResult && isCurrentCommandFeedback(feedbackOperation, "pending")) {
          setServiceProbeFailures((current) => ({
            ...current,
            [monitorId]: {
              operationId: feedbackOperation.operationId,
              previousObservedAt,
            },
          }));
          transitionCommandFeedback(feedbackOperation, "failure");
        }
        return { error: typedError, ok: false } satisfies ProductCommandResult;
      } finally {
        if (
          commandControllers.current.get(key)?.operation.operationId ===
          feedbackOperation.operationId
        ) {
          commandControllers.current.delete(key);
        }
      }
    },
    [
      acceptSnapshot,
      beginCommandFeedback,
      isCurrentCommandFeedback,
      resolvedClient,
      transitionCommandFeedback,
    ],
  );

  const commandStates = useMemo(() => {
    const states = createInitialCommandStates();
    const operationsByCommand = new Map<ProductCommand, CommandFeedbackOperation[]>();
    for (const operation of commandFeedbackState.operations.values()) {
      const command = commandDomains.current.get(operation.domainKey);
      if (!command) continue;
      const operations = operationsByCommand.get(command) ?? [];
      operations.push(operation);
      operationsByCommand.set(command, operations);
    }
    for (const [command, operations] of operationsByCommand) {
      if (operations.some((operation) => operation.phase === "pending")) {
        states[command] = { phase: "pending" };
        continue;
      }
      const operation = operations.at(-1);
      if (!operation) continue;
      if (operation.phase === "pending" || operation.phase === "success") {
        states[command] = { phase: operation.phase };
        continue;
      }
      if (operation.phase === "failure" || operation.phase === "disconnected") {
        const payload = commandFailures[operation.domainKey];
        states[command] = {
          error:
            payload?.operationId === operation.operationId
              ? payload.error
              : new StatusClientError(
                  operation.phase === "disconnected" ? "disconnected" : "unknown",
                  operation.phase === "disconnected"
                    ? "The Status command disconnected"
                    : "Unknown Status client failure",
                ),
          phase: "failure",
        };
      }
    }
    return states;
  }, [commandFailures, commandFeedbackState]);

  const serviceProbeStates = useMemo(() => {
    const states: Record<string, ServiceProbeCommandState> = {};
    for (const [monitorId, failure] of Object.entries(serviceProbeFailures)) {
      const operation = commandFeedbackState.operations.get(
        productCommandDomain(`services:probe:${monitorId}`),
      );
      if (operation?.operationId === failure.operationId && operation.phase === "failure") {
        states[monitorId] = {
          phase: "failure",
          previousObservedAt: failure.previousObservedAt,
        };
      }
    }
    for (const operation of commandFeedbackState.operations.values()) {
      const prefix = productCommandDomain("services:probe:");
      if (!operation.domainKey.startsWith(prefix)) continue;
      const monitorId = operation.domainKey.slice(prefix.length);
      if (operation.phase === "pending" || operation.phase === "success") {
        states[monitorId] = { phase: operation.phase };
      } else if (operation.phase === "disconnected") {
        states[monitorId] = { phase: "failure", previousObservedAt: null };
      }
    }
    return states;
  }, [commandFeedbackState, serviceProbeFailures]);

  const localProxyTest = useMemo<LocalProxyTestState>(() => {
    const operation = commandFeedbackState.operations.get(productCommandDomain("local-proxy"));
    if (!operation || operation.phase === "cancelled" || operation.phase === "superseded") {
      return { phase: "idle" };
    }
    if (operation.phase === "pending") return { phase: "pending" };
    if (
      operation.phase === "success" &&
      localProxyPayload &&
      "result" in localProxyPayload &&
      localProxyPayload.operationId === operation.operationId
    ) {
      return { phase: "success", result: localProxyPayload.result };
    }
    if (
      operation.phase === "failure" &&
      localProxyPayload &&
      "error" in localProxyPayload &&
      localProxyPayload.operationId === operation.operationId
    ) {
      return { error: localProxyPayload.error, phase: "failure" };
    }
    if (operation.phase === "disconnected") {
      return {
        error: new StatusClientError("disconnected", "The local proxy test disconnected"),
        phase: "failure",
      };
    }
    return { phase: "idle" };
  }, [commandFeedbackState, localProxyPayload]);

  const value = useMemo<ProductContextValue>(
    () => ({
      commandStates,
      connection,
      error: loadFailed
        ? LL.errors.loadStatus()
        : Object.values(commandStates).some((state) => state.phase === "failure")
          ? commandErrorMessage(LL, commandStates)
          : null,
      isCommandPending: (command) =>
        commandStates[command].phase === "pending" ||
        (command === "capture" && snapshot?.runtime.captureOperation.phase === "pending"),
      isCommandSupported: (command) =>
        resolvedClient.supportsCommand(command) &&
        (connection.phase === "fixture" || !connection.stale),
      isGroupCommandPending: (groupId) =>
        commandFeedbackState.operations.get(productCommandDomain(`group:${groupId}`))?.phase ===
        "pending",
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
      setCapture: (selection, active) =>
        runCommand("capture", (signal) => resolvedClient.setCapture(selection, active, { signal })),
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
      commandStates,
      commandFeedbackState,
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
