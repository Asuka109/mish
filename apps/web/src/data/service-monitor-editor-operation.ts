export const SERVICE_MONITOR_EDITOR_DOMAIN = "service-monitor-editor" as const;

export type ServiceMonitorEditorOperationKind = "edit" | "save" | "reset" | "restore-defaults";

export type ServiceMonitorEditorTerminalPhase = "success" | "failure" | "cancelled" | "superseded";

export type ServiceMonitorEditorPhase = "pending" | ServiceMonitorEditorTerminalPhase;

export interface ServiceMonitorEditorOperation {
  readonly domainKey: typeof SERVICE_MONITOR_EDITOR_DOMAIN;
  readonly kind: ServiceMonitorEditorOperationKind;
  readonly operationId: string;
  readonly phase: ServiceMonitorEditorPhase;
}

export interface ServiceMonitorEditorOperationIdentity {
  readonly domainKey: typeof SERVICE_MONITOR_EDITOR_DOMAIN;
  readonly operationId: string;
}

export interface ServiceMonitorEditorAuthority {
  begin(kind: ServiceMonitorEditorOperationKind): ServiceMonitorEditorOperation | null;
  cancel(operation: ServiceMonitorEditorOperationIdentity): boolean;
  cleanup(operation: ServiceMonitorEditorOperationIdentity): boolean;
  complete(
    operation: ServiceMonitorEditorOperationIdentity,
    phase: Extract<ServiceMonitorEditorTerminalPhase, "success" | "failure">,
  ): boolean;
  current(): ServiceMonitorEditorOperation | null;
  isCurrent(
    operation: ServiceMonitorEditorOperationIdentity,
    phase?: ServiceMonitorEditorPhase,
  ): boolean;
  isPending(): boolean;
  supersede(operation: ServiceMonitorEditorOperationIdentity): boolean;
}

export interface CreateServiceMonitorEditorAuthorityOptions {
  createOperationId?: () => string;
}

/**
 * Owns the single local service-monitor editor command slot.
 *
 * The RPC client remains the owner of ServiceMonitor DTOs and snapshots. This
 * authority only decides whether a UI-side editor completion still belongs to
 * the operation that initiated it.
 */
export function createServiceMonitorEditorAuthority(
  options: CreateServiceMonitorEditorAuthorityOptions = {},
): ServiceMonitorEditorAuthority {
  let currentOperation: ServiceMonitorEditorOperation | null = null;
  let sequence = 0;

  const createOperationId =
    options.createOperationId ??
    (() => {
      sequence += 1;
      return `service-monitor-editor-${sequence}`;
    });

  function matches(
    operation: ServiceMonitorEditorOperation | null,
    expected: ServiceMonitorEditorOperationIdentity,
  ): operation is ServiceMonitorEditorOperation {
    return (
      operation?.domainKey === expected.domainKey && operation.operationId === expected.operationId
    );
  }

  function transition(
    operation: ServiceMonitorEditorOperationIdentity,
    phase: ServiceMonitorEditorTerminalPhase,
  ) {
    if (!matches(currentOperation, operation) || currentOperation.phase !== "pending") return false;
    currentOperation = { ...currentOperation, phase };
    return true;
  }

  return {
    begin(kind) {
      if (currentOperation?.phase === "pending") return null;
      currentOperation = {
        domainKey: SERVICE_MONITOR_EDITOR_DOMAIN,
        kind,
        operationId: createOperationId(),
        phase: "pending",
      };
      return currentOperation;
    },
    cancel(operation) {
      return transition(operation, "cancelled");
    },
    cleanup(operation) {
      if (!matches(currentOperation, operation) || currentOperation.phase === "pending") {
        return false;
      }
      currentOperation = null;
      return true;
    },
    complete(operation, phase) {
      return transition(operation, phase);
    },
    current() {
      return currentOperation;
    },
    isCurrent(operation, phase) {
      return matches(currentOperation, operation) && (!phase || currentOperation.phase === phase);
    },
    isPending() {
      return currentOperation?.phase === "pending";
    },
    supersede(operation) {
      return transition(operation, "superseded");
    },
  };
}
