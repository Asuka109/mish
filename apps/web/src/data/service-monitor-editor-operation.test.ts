import { describe, expect, it } from "vitest";
import {
  createServiceMonitorEditorAuthority,
  SERVICE_MONITOR_EDITOR_DOMAIN,
  type ServiceMonitorEditorOperation,
} from "./service-monitor-editor-operation";

function identity(operation: ServiceMonitorEditorOperation) {
  return {
    domainKey: operation.domainKey,
    operationId: operation.operationId,
  };
}

describe("service-monitor editor operation authority", () => {
  it("assigns one domain identity to every editor initiation", () => {
    const ids = ["edit-1", "save-1"];
    const authority = createServiceMonitorEditorAuthority({
      createOperationId: () => {
        const id = ids.shift();
        if (!id) throw new Error("missing deterministic operation id");
        return id;
      },
    });

    const edit = authority.begin("edit");
    expect(edit).toMatchObject({
      domainKey: SERVICE_MONITOR_EDITOR_DOMAIN,
      kind: "edit",
      operationId: "edit-1",
      phase: "pending",
    });
    expect(authority.complete(identity(edit!), "success")).toBe(true);

    const save = authority.begin("save");
    expect(save).toMatchObject({
      domainKey: SERVICE_MONITOR_EDITOR_DOMAIN,
      kind: "save",
      operationId: "save-1",
      phase: "pending",
    });
    expect(save?.domainKey).toBe(edit?.domainKey);
    expect(save?.operationId).not.toBe(edit?.operationId);
  });

  it.each(["edit", "save", "reset", "restore-defaults"] as const)(
    "excludes an overlapping %s initiation while another owner is pending",
    (kind) => {
      const authority = createServiceMonitorEditorAuthority({
        createOperationId: () => "owner",
      });
      const owner = authority.begin("save");

      expect(authority.begin(kind)).toBeNull();
      expect(authority.isPending()).toBe(true);
      expect(authority.current()).toEqual(owner);
    },
  );

  it("rejects a late completion after supersession and accepts only the replacement owner", () => {
    let nextId = 0;
    const authority = createServiceMonitorEditorAuthority({
      createOperationId: () => `operation-${++nextId}`,
    });
    const oldOperation = authority.begin("save");
    expect(oldOperation).not.toBeNull();
    expect(authority.supersede(identity(oldOperation!))).toBe(true);

    const replacement = authority.begin("restore-defaults");
    expect(replacement).not.toBeNull();
    expect(authority.complete(identity(oldOperation!), "success")).toBe(false);
    expect(authority.current()).toMatchObject({
      kind: "restore-defaults",
      operationId: "operation-2",
      phase: "pending",
    });
    expect(authority.complete(identity(replacement!), "success")).toBe(true);
    expect(authority.isCurrent(identity(replacement!), "success")).toBe(true);
  });

  it("releases the pending slot after failure and supports exact cleanup", () => {
    const authority = createServiceMonitorEditorAuthority({
      createOperationId: () => "operation-1",
    });
    const failed = authority.begin("reset");
    expect(failed).not.toBeNull();
    expect(authority.complete(identity(failed!), "failure")).toBe(true);
    expect(authority.isPending()).toBe(false);
    expect(authority.cleanup(identity(failed!))).toBe(true);
    expect(authority.current()).toBeNull();
    expect(authority.cleanup(identity(failed!))).toBe(false);
    expect(authority.begin("edit")).not.toBeNull();
  });
});
