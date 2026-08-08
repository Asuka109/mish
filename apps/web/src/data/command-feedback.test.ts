import { describe, expect, it } from "vitest";
import {
  applicationCommandAuthority,
  applicationCommandScope,
  captureCommandAuthority,
  captureCommandScope,
  commandFeedbackReducer,
  createCommandFeedbackState,
  type CommandFeedbackIdentity,
  type CommandFeedbackOperation,
  type CommandFeedbackTerminalPhase,
} from "./command-feedback";

const terminalPhases: readonly CommandFeedbackTerminalPhase[] = [
  "success",
  "failure",
  "cancelled",
  "disconnected",
  "superseded",
];

function pending(
  operationId: string,
  scopeKey = "scope-a",
  domainKey = "domain",
): CommandFeedbackOperation {
  return {
    confirmedAuthority: {
      authorityId: "application",
      epoch: 1,
      revision: 3,
    },
    domainKey,
    operationId,
    phase: "pending",
    scopeKey,
  };
}

function begin(
  state: ReturnType<typeof createCommandFeedbackState>,
  operation: CommandFeedbackOperation,
) {
  return commandFeedbackReducer(state, { operation, type: "begin" });
}

describe("commandFeedbackReducer", () => {
  it.each(terminalPhases)("allows pending -> %s -> exact cleanup", (phase) => {
    const operation = pending(`operation-${phase}`);
    const started = begin(createCommandFeedbackState(), operation);
    const terminal = commandFeedbackReducer(started, {
      operation,
      phase,
      type: "transition",
    });
    expect(terminal.operations.get(operation.domainKey)?.phase).toBe(phase);
    expect(commandFeedbackReducer(terminal, { operation, type: "cleanup" }).operations.size).toBe(
      0,
    );
  });

  it("rejects duplicate domain submissions and illegal terminal transitions", () => {
    const first = pending("operation-1");
    const started = begin(createCommandFeedbackState(), first);
    const duplicate = begin(started, pending("operation-2", "scope-b"));
    const prematureCleanup = commandFeedbackReducer(duplicate, {
      operation: first,
      type: "cleanup",
    });
    const wrongOperation = commandFeedbackReducer(prematureCleanup, {
      operation: { ...first, operationId: "operation-2" },
      phase: "success",
      type: "transition",
    });

    expect(duplicate).toBe(started);
    expect(prematureCleanup).toBe(started);
    expect(wrongOperation).toBe(started);
  });

  it("does not let an old finally clear a newer operation", () => {
    const oldOperation = pending("operation-old");
    let state = begin(createCommandFeedbackState(), oldOperation);
    state = commandFeedbackReducer(state, {
      operation: oldOperation,
      phase: "success",
      type: "transition",
    });

    const newOperation = pending("operation-new");
    state = begin(state, newOperation);
    const afterOldFinally = commandFeedbackReducer(state, {
      operation: oldOperation,
      type: "cleanup",
    });

    expect(afterOldFinally).toBe(state);
    expect(afterOldFinally.operations.get("domain")).toEqual(newOperation);
  });

  it("orders terminal operations by completion rather than submission", () => {
    const first = pending("operation-first", "scope", "domain-first");
    const second = pending("operation-second", "scope", "domain-second");
    let state = begin(begin(createCommandFeedbackState(), first), second);

    state = commandFeedbackReducer(state, {
      operation: second,
      phase: "success",
      type: "transition",
    });
    state = commandFeedbackReducer(state, {
      operation: first,
      phase: "failure",
      type: "transition",
    });

    expect([...state.operations.values()].at(-1)).toMatchObject({
      domainKey: "domain-first",
      phase: "failure",
    });
  });

  it("does not publish stale success or failure into a replaced scope", () => {
    for (const phase of ["success", "failure"] as const) {
      const oldOperation = pending(`old-${phase}`);
      let state = begin(createCommandFeedbackState(), oldOperation);
      state = commandFeedbackReducer(state, {
        operation: oldOperation,
        phase: "superseded",
        type: "transition",
      });
      const replacement = pending(`new-${phase}`, "scope-b");
      state = begin(state, replacement);

      const staleTerminal = commandFeedbackReducer(state, {
        operation: oldOperation,
        phase,
        type: "transition",
      });
      expect(staleTerminal).toBe(state);
      expect(staleTerminal.operations.get("domain")).toEqual(replacement);
    }
  });

  it("supersedes only the exact pending operation after a newer confirmed authority", () => {
    const operation = pending("operation");
    const other = pending("other", "scope-b", "other-domain");
    let state = begin(begin(createCommandFeedbackState(), operation), other);

    const equal = commandFeedbackReducer(state, {
      authority: { authorityId: "application", epoch: 1, revision: 3 },
      operation,
      type: "authority-confirmed",
    });
    expect(equal).toBe(state);

    state = commandFeedbackReducer(state, {
      authority: { authorityId: "application", epoch: 1, revision: 4 },
      operation,
      type: "authority-confirmed",
    });
    expect(state.operations.get("domain")?.phase).toBe("superseded");
    expect(state.operations.get("other-domain")).toEqual(other);
  });

  it("treats a confirmed application or nested Capture epoch replacement as newer", () => {
    const operation = pending("operation");
    let state = begin(createCommandFeedbackState(), operation);
    state = commandFeedbackReducer(state, {
      authority: { authorityId: "replacement", epoch: 0, revision: 0 },
      operation,
      type: "authority-confirmed",
    });
    expect(state.operations.get("domain")?.phase).toBe("superseded");

    const captureOperation = {
      ...pending("capture"),
      confirmedAuthority: {
        authorityId: "application",
        epoch: 1,
        revision: "9",
        scopeEpoch: "capture-a",
      },
    };
    state = begin(state, captureOperation);
    state = commandFeedbackReducer(state, {
      authority: {
        authorityId: "application",
        epoch: 1,
        revision: "1",
        scopeEpoch: "capture-b",
      },
      operation: captureOperation,
      type: "authority-confirmed",
    });
    expect(state.operations.get("domain")?.phase).toBe("superseded");
  });

  it("preserves a newer operation across every stale terminal and cleanup pair", () => {
    for (let index = 0; index < 64; index += 1) {
      const oldOperation = pending(`old-${index}`);
      let state = begin(createCommandFeedbackState(), oldOperation);
      state = commandFeedbackReducer(state, {
        operation: oldOperation,
        phase: terminalPhases[index % terminalPhases.length]!,
        type: "transition",
      });
      const replacement = pending(`replacement-${index}`);
      state = begin(state, replacement);

      for (const phase of terminalPhases) {
        state = commandFeedbackReducer(state, {
          operation: oldOperation,
          phase,
          type: "transition",
        });
      }
      state = commandFeedbackReducer(state, {
        operation: oldOperation,
        type: "cleanup",
      });
      expect(state.operations.get("domain")).toEqual(replacement);
    }
  });
});

describe("command feedback authority adapters", () => {
  it("uses landed application and Capture identities without a parallel token", () => {
    const order = { authorityId: "application-a", epoch: 7, order: 11 };
    const capture = {
      failure: null,
      operationId: "42",
      phase: "pending" as const,
      scopeEpoch: "capture-a",
    };

    expect(applicationCommandScope(order, "traffic", "session-a")).toBe(
      '["application-a",7,"traffic","session-a"]',
    );
    expect(applicationCommandAuthority(order)).toEqual({
      authorityId: "application-a",
      epoch: 7,
      revision: 11,
    });
    expect(captureCommandScope(order, capture)).toBe('["application-a",7,"capture","capture-a"]');
    expect(captureCommandAuthority(order, capture)).toEqual({
      authorityId: "application-a",
      epoch: 7,
      revision: "42",
      scopeEpoch: "capture-a",
    });
  });

  it("requires operation, domain, and scope identity for a terminal transition", () => {
    const operation = pending("operation");
    const started = begin(createCommandFeedbackState(), operation);
    const mismatches: CommandFeedbackIdentity[] = [
      { ...operation, domainKey: "other-domain" },
      { ...operation, operationId: "other-operation" },
      { ...operation, scopeKey: "other-scope" },
    ];

    for (const mismatch of mismatches) {
      expect(
        commandFeedbackReducer(started, {
          operation: mismatch,
          phase: "failure",
          type: "transition",
        }),
      ).toBe(started);
    }
  });
});
