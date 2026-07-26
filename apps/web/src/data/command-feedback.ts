import type { ApplicationSnapshotOrderDto, CaptureOperationStatusDto } from "@mish/contracts";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

export type CommandFeedbackTerminalPhase =
  | "success"
  | "failure"
  | "cancelled"
  | "disconnected"
  | "superseded";
export type CommandFeedbackPhase = "pending" | CommandFeedbackTerminalPhase;

export interface CommandFeedbackAuthority {
  authorityId: string;
  epoch: number;
  revision: number | string;
  scopeEpoch?: string;
}

export interface CommandFeedbackIdentity {
  domainKey: string;
  operationId: string;
  scopeKey: string;
}

export interface CommandFeedbackOperation extends CommandFeedbackIdentity {
  confirmedAuthority?: CommandFeedbackAuthority;
  phase: CommandFeedbackPhase;
}

export interface CommandFeedbackState {
  operations: ReadonlyMap<string, CommandFeedbackOperation>;
}

export type CommandFeedbackAction =
  | { operation: CommandFeedbackOperation; type: "begin" }
  | {
      operation: CommandFeedbackIdentity;
      phase: CommandFeedbackTerminalPhase;
      type: "transition";
    }
  | {
      authority: CommandFeedbackAuthority;
      operation: CommandFeedbackIdentity;
      type: "authority-confirmed";
    }
  | { operation: CommandFeedbackIdentity; type: "cleanup" };

export interface BeginCommandFeedback {
  confirmedAuthority?: CommandFeedbackAuthority;
  domainKey: string;
  operationId?: string;
  scopeKey: string;
}

export interface CommandFeedbackController {
  begin(input: BeginCommandFeedback): CommandFeedbackOperation | null;
  cleanup(operation: CommandFeedbackIdentity): boolean;
  confirmAuthority(
    operation: CommandFeedbackIdentity,
    authority: CommandFeedbackAuthority,
  ): boolean;
  isCurrent(operation: CommandFeedbackIdentity, phase?: CommandFeedbackPhase): boolean;
  reset(phase: Extract<CommandFeedbackTerminalPhase, "cancelled" | "disconnected">): void;
  resetPending(phase: Extract<CommandFeedbackTerminalPhase, "cancelled" | "disconnected">): void;
  state: CommandFeedbackState;
  transition(operation: CommandFeedbackIdentity, phase: CommandFeedbackTerminalPhase): boolean;
}

export function createCommandFeedbackState(): CommandFeedbackState {
  return { operations: new Map() };
}

export function commandFeedbackReducer(
  state: CommandFeedbackState,
  action: CommandFeedbackAction,
): CommandFeedbackState {
  const current = state.operations.get(action.operation.domainKey);

  switch (action.type) {
    case "begin": {
      if (current?.phase === "pending") return state;
      return replaceOperation(state, action.operation, true);
    }
    case "transition": {
      if (!matchesPendingOperation(current, action.operation)) return state;
      return replaceOperation(state, { ...current, phase: action.phase }, true);
    }
    case "authority-confirmed": {
      if (!matchesPendingOperation(current, action.operation)) return state;
      if (!isConfirmedAuthorityNewer(action.authority, current.confirmedAuthority)) return state;
      return replaceOperation(state, { ...current, phase: "superseded" }, true);
    }
    case "cleanup": {
      if (!matchesOperation(current, action.operation) || current.phase === "pending") return state;
      const operations = new Map(state.operations);
      operations.delete(action.operation.domainKey);
      return { operations };
    }
  }
}

export function useCommandFeedback(): CommandFeedbackController {
  const [state, dispatch] = useReducer(
    commandFeedbackReducer,
    undefined,
    createCommandFeedbackState,
  );
  const stateRef = useRef(state);
  const mountedRef = useRef(true);

  const apply = useCallback((action: CommandFeedbackAction) => {
    const next = commandFeedbackReducer(stateRef.current, action);
    if (next === stateRef.current) return false;
    stateRef.current = next;
    if (mountedRef.current) dispatch(action);
    return true;
  }, []);

  const resetPending = useCallback(
    (phase: Extract<CommandFeedbackTerminalPhase, "cancelled" | "disconnected">) => {
      for (const operation of stateRef.current.operations.values()) {
        if (operation.phase === "pending") {
          apply({ operation, phase, type: "transition" });
        }
      }
    },
    [apply],
  );
  const reset = useCallback(
    (phase: Extract<CommandFeedbackTerminalPhase, "cancelled" | "disconnected">) => {
      const operations = [...stateRef.current.operations.values()];
      for (const operation of operations) {
        if (operation.phase === "pending") {
          apply({ operation, phase, type: "transition" });
        }
        apply({ operation, type: "cleanup" });
      }
    },
    [apply],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const operation of stateRef.current.operations.values()) {
        if (operation.phase !== "pending") continue;
        stateRef.current = commandFeedbackReducer(stateRef.current, {
          operation,
          phase: "cancelled",
          type: "transition",
        });
      }
    };
  }, []);

  const begin = useCallback(
    (input: BeginCommandFeedback) => {
      const operation: CommandFeedbackOperation = {
        ...input,
        operationId: input.operationId ?? crypto.randomUUID(),
        phase: "pending",
      };
      return apply({ operation, type: "begin" }) ? operation : null;
    },
    [apply],
  );
  const cleanup = useCallback(
    (operation: CommandFeedbackIdentity) => apply({ operation, type: "cleanup" }),
    [apply],
  );
  const confirmAuthority = useCallback(
    (operation: CommandFeedbackIdentity, authority: CommandFeedbackAuthority) =>
      apply({ authority, operation, type: "authority-confirmed" }),
    [apply],
  );
  const isCurrent = useCallback(
    (operation: CommandFeedbackIdentity, phase?: CommandFeedbackPhase) => {
      const current = stateRef.current.operations.get(operation.domainKey);
      return matchesOperation(current, operation) && (!phase || current.phase === phase);
    },
    [],
  );
  const transition = useCallback(
    (operation: CommandFeedbackIdentity, phase: CommandFeedbackTerminalPhase) =>
      apply({ operation, phase, type: "transition" }),
    [apply],
  );

  return useMemo(
    () => ({
      begin,
      cleanup,
      confirmAuthority,
      isCurrent,
      reset,
      resetPending,
      state,
      transition,
    }),
    [begin, cleanup, confirmAuthority, isCurrent, reset, resetPending, state, transition],
  );
}

export function applicationCommandAuthority(
  order: ApplicationSnapshotOrderDto,
): CommandFeedbackAuthority {
  return {
    authorityId: order.authorityId,
    epoch: order.epoch,
    revision: order.order,
  };
}

export function captureCommandAuthority(
  order: ApplicationSnapshotOrderDto,
  capture: CaptureOperationStatusDto,
): CommandFeedbackAuthority {
  return {
    authorityId: order.authorityId,
    epoch: order.epoch,
    revision: capture.operationId ?? "0",
    scopeEpoch: capture.scopeEpoch,
  };
}

export function applicationCommandScope(
  order: ApplicationSnapshotOrderDto,
  ...nestedScope: readonly string[]
): string {
  return JSON.stringify([order.authorityId, order.epoch, ...nestedScope]);
}

export function captureCommandScope(
  order: ApplicationSnapshotOrderDto,
  capture: CaptureOperationStatusDto,
): string {
  return applicationCommandScope(order, "capture", capture.scopeEpoch);
}

function replaceOperation(
  state: CommandFeedbackState,
  operation: CommandFeedbackOperation,
  moveToEnd = false,
): CommandFeedbackState {
  const operations = new Map(state.operations);
  if (moveToEnd) operations.delete(operation.domainKey);
  operations.set(operation.domainKey, operation);
  return { operations };
}

function matchesOperation(
  current: CommandFeedbackOperation | undefined,
  expected: CommandFeedbackIdentity,
): current is CommandFeedbackOperation {
  return (
    current?.domainKey === expected.domainKey &&
    current.operationId === expected.operationId &&
    current.scopeKey === expected.scopeKey
  );
}

function matchesPendingOperation(
  current: CommandFeedbackOperation | undefined,
  expected: CommandFeedbackIdentity,
): current is CommandFeedbackOperation & { phase: "pending" } {
  return matchesOperation(current, expected) && current.phase === "pending";
}

function isConfirmedAuthorityNewer(
  next: CommandFeedbackAuthority,
  base: CommandFeedbackAuthority | undefined,
): boolean {
  if (!base || next.authorityId !== base.authorityId) return true;
  if (next.epoch !== base.epoch) return next.epoch > base.epoch;
  if (next.scopeEpoch !== base.scopeEpoch) return true;
  return compareRevision(next.revision, base.revision) > 0;
}

function compareRevision(left: number | string, right: number | string): number {
  const leftInteger = toBigInt(left);
  const rightInteger = toBigInt(right);
  if (leftInteger !== null && rightInteger !== null) {
    if (leftInteger === rightInteger) return 0;
    return leftInteger > rightInteger ? 1 : -1;
  }
  return String(left).localeCompare(String(right));
}

function toBigInt(value: number | string): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  return /^(0|[1-9]\d*)$/u.test(value) ? BigInt(value) : null;
}
