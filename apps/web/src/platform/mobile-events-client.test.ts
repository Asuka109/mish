import type { EventsSnapshotDto, MobileDiagnosticSnapshotDto } from "@mish/contracts";
import { describe, expect, it, vi } from "vitest";
import { MobileEventsClient } from "./mobile-events-client";

function eventsSnapshot(
  sequence = 1,
  authorityId = "events-authority-a",
  epoch = 1,
  sessionId = "events-session-a",
): EventsSnapshotDto {
  return {
    adapterKind: "native",
    applicationOrder: { authorityId, epoch, order: sequence },
    events: [
      {
        application: null,
        evidence: { detail: "Closed typed detail.", message: "Closed typed message." },
        id: `${sessionId}:${sequence}`,
        level: "info",
        observedAt: sequence,
        sequence,
        source: "platform",
      },
    ],
    phase: "ready",
    profileId: "android-mobile-runtime",
    reconnectCount: 0,
    sequence,
    sessionId,
    sourceStatuses: ["application", "core", "platform", "rpc"].map((source) => ({
      detail: null,
      phase: source === "platform" ? "ready" : "unavailable",
      source,
    })) as EventsSnapshotDto["sourceStatuses"],
  };
}

function diagnosticSnapshot(
  sequence = 1,
  authorityId = "diagnostic-authority-a",
  epoch = 1,
): MobileDiagnosticSnapshotDto {
  return {
    activeRun: null,
    adapterKind: "native",
    applicationOrder: { authorityId, epoch, order: sequence },
    authorityId,
    history: [],
    policy: {
      policyId: "android-connectivity-v1",
      target: "https://www.gstatic.com/generate_204",
      timeoutMillis: 5_000,
    },
    sequence,
    sessionId: `diagnostic-session-${authorityId}`,
  };
}

class Transport {
  events = eventsSnapshot();
  diagnostic = diagnosticSnapshot();
  readonly handlers = new Map<string, (payload: unknown) => void>();
  readonly invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_events_snapshot") return structuredClone(this.events);
    if (command === "get_diagnostic_snapshot") return structuredClone(this.diagnostic);
    if (command === "start_diagnostic") {
      const operationId = (args?.request as { operationId?: unknown } | undefined)?.operationId;
      if (typeof operationId !== "string") throw new Error("Missing diagnostic operation ID.");
      this.diagnostic = {
        ...this.diagnostic,
        activeRun: {
          checks: [],
          failure: null,
          operationId,
          phase: "pending",
          runId: "rust-minted-run",
        },
        applicationOrder: { ...this.diagnostic.applicationOrder, order: 2 },
        sequence: 2,
      };
      return {
        accepted: true,
        operationId,
        runId: "rust-minted-run",
        snapshot: this.diagnostic,
      };
    }
    if (command === "cancel_diagnostic") {
      const request = args?.request as { operationId: string; runId: string };
      const run = this.diagnostic.activeRun!;
      this.diagnostic = {
        ...this.diagnostic,
        activeRun: null,
        applicationOrder: { ...this.diagnostic.applicationOrder, order: 3 },
        history: [{ ...run, failure: "cancelled", phase: "cancelled" }],
        sequence: 3,
      };
      return { accepted: true, ...request, snapshot: this.diagnostic };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  readonly listen = vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  });
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MobileEventsClient", () => {
  it("subscribes before complete baselines and recreates from bounded current state", async () => {
    const transport = new Transport();
    const first = new MobileEventsClient(transport);
    await first.initialize();
    expect(transport.listen.mock.invocationCallOrder[0]).toBeLessThan(
      transport.invoke.mock.invocationCallOrder[0]!,
    );
    expect((await first.getSnapshot()).sequence).toBe(1);
    first.dispose();

    transport.events = eventsSnapshot(7);
    transport.diagnostic = diagnosticSnapshot(4);
    const recreated = new MobileEventsClient(transport);
    await recreated.initialize();
    expect((await recreated.getSnapshot()).sequence).toBe(7);
    expect((await recreated.getDiagnosticSnapshot()).sequence).toBe(4);
  });

  it("recovers a sequence gap from a complete baseline", async () => {
    const transport = new Transport();
    const client = new MobileEventsClient(transport);
    await client.initialize();
    const observed: number[] = [];
    client.subscribeSnapshots((snapshot) => observed.push(snapshot.sequence));
    transport.events = eventsSnapshot(5);
    transport.handlers.get("mish-vpn://events")?.(eventsSnapshot(3));
    await settle();
    expect(observed).toEqual([1, 5]);
    expect(client.getConnectionState().stale).toBe(false);
  });

  it("accepts replacement only through baseline and gives retired notifications zero mutation", async () => {
    const transport = new Transport();
    const client = new MobileEventsClient(transport);
    await client.initialize();
    transport.events = eventsSnapshot(1, "events-authority-b", 1, "events-session-b");
    transport.handlers.get("mish-vpn://events")?.(transport.events);
    await settle();
    expect((await client.getSnapshot()).applicationOrder.authorityId).toBe("events-authority-b");

    transport.events = eventsSnapshot(2, "events-authority-b", 1, "events-session-b");
    transport.handlers.get("mish-vpn://events")?.(
      eventsSnapshot(99, "events-authority-a", 1, "events-session-a"),
    );
    await settle();
    expect((await client.getSnapshot()).sequence).toBe(1);
  });

  it("rejects unbounded or unredacted-shaped wire payloads before view state", async () => {
    const transport = new Transport();
    const client = new MobileEventsClient(transport);
    await client.initialize();
    const invalid = {
      ...eventsSnapshot(2),
      events: [{ ...eventsSnapshot(2).events[0], rawException: "JNI secret" }],
    };
    expect(() => transport.handlers.get("mish-vpn://events")?.(invalid)).toThrow();
    const invalidDiagnostic = {
      ...diagnosticSnapshot(2),
      history: Array.from({ length: 9 }, (_, index) => ({
        checks: [],
        failure: null,
        operationId: `op-${index}`,
        phase: "completed",
        runId: `run-${index}`,
      })),
    };
    expect(() => transport.handlers.get("mish-vpn://diagnostic")?.(invalidDiagnostic)).toThrow();
  });

  it("sends only operation and Rust-minted run identities for the one cancellable probe", async () => {
    const transport = new Transport();
    const client = new MobileEventsClient(transport);
    await client.initialize();
    const started = await client.start("operation-1");
    expect(started.runId).toBe("rust-minted-run");
    expect(transport.invoke).toHaveBeenCalledWith("start_diagnostic", {
      request: { operationId: "operation-1" },
    });
    const cancelled = await client.cancel("operation-1", "rust-minted-run");
    expect(cancelled.snapshot.history[0]?.phase).toBe("cancelled");
    expect(transport.invoke).toHaveBeenCalledWith("cancel_diagnostic", {
      request: { operationId: "operation-1", runId: "rust-minted-run" },
    });
    expect(JSON.stringify(transport.invoke.mock.calls)).not.toContain("timeoutMillis");
  });

  it("recovers diagnostic replacement by baseline and ignores the retired completion", async () => {
    const transport = new Transport();
    const client = new MobileEventsClient(transport);
    await client.initialize();
    transport.diagnostic = diagnosticSnapshot(1, "diagnostic-authority-b", 1);
    transport.handlers.get("mish-vpn://diagnostic")?.(transport.diagnostic);
    await settle();
    expect((await client.getDiagnosticSnapshot()).authorityId).toBe("diagnostic-authority-b");
    transport.handlers.get("mish-vpn://diagnostic")?.(
      diagnosticSnapshot(99, "diagnostic-authority-a", 1),
    );
    await settle();
    expect((await client.getDiagnosticSnapshot()).sequence).toBe(1);
  });
});
