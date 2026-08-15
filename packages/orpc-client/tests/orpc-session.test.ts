import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BoundedTranscript,
  MessagePortTransport,
  OrpcSessionAuthority,
  OrpcSessionError,
  WebSocketTransport,
  replayTranscript,
  type DeadlineScheduler,
} from "../src/index.js";

import { createOrpcFixture, type OrpcFixture } from "./support/orpc-fixture.js";

const fixtures: OrpcFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function track<T extends OrpcFixture>(fixture: T): T {
  fixtures.push(fixture);
  return fixture;
}

function createSession(
  options: Partial<ConstructorParameters<typeof OrpcSessionAuthority>[0]> = {},
  clientName: "electron" | "web" = "web",
): OrpcSessionAuthority {
  return new OrpcSessionAuthority({
    authToken: "fixture-auth-token",
    clientName,
    clientVersion: "test-client",
    maxMessageBytes: options.maxMessageBytes ?? 2_048,
    ...options,
  });
}

class ManualScheduler implements DeadlineScheduler {
  #nextId = 1;
  readonly #callbacks = new Map<number, () => void>();

  schedule(_delayMs: number, callback: () => void): number {
    const id = this.#nextId++;
    this.#callbacks.set(id, callback);
    return id;
  }

  cancel(handle: unknown): void {
    this.#callbacks.delete(handle as number);
  }

  fireAll(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

async function flushMicrotasks(count = 64): Promise<void> {
  await Array.from({ length: count }, () => undefined).reduce(
    (promise) => promise.then(() => undefined),
    Promise.resolve(),
  );
}

describe("contract-first oRPC session authority", () => {
  it("authenticates before application calls and consumes WebSocket events", async () => {
    const fixture = track(createOrpcFixture({ maxMessageBytes: 512 }));
    const transcript = new BoundedTranscript({ maxEvents: 64 });
    const authority = createSession({ transcript });
    const transport = new WebSocketTransport(fixture.clientWebSocket, 2_048);

    await expect(authority.invoke("status.snapshot")).rejects.toMatchObject({
      kind: "not-connected",
    });
    expect(fixture.metrics.receivedOperations).not.toContain("/application/invoke");
    await expect(authority.connect(transport)).resolves.toMatchObject({
      contractVersion: 1,
      maxMessageBytes: 512,
      parentEpoch: 1,
      protocolVersion: 1,
      revision: 1,
      sessionGeneration: 1,
    });
    await expect(authority.invoke("status.snapshot")).resolves.toMatchObject({
      correlationId: "orpc-correlation-0002",
      parentEpoch: 1,
      revision: 1,
      sessionGeneration: 1,
      value: "accepted",
    });

    const events = await authority.watchEvents();
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: {
        correlationId: "orpc-correlation-0003",
        parentEpoch: 1,
        revision: 1,
        sequence: 1,
        sessionGeneration: 1,
        value: "ready",
      },
    });
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 2, value: "changed" },
    });
    await expect(events.next()).resolves.toMatchObject({ done: true });
    expect(fixture.metrics.activeStreams).toBe(0);
    expect(fixture.metrics.cleanupCount).toBe(1);
    expect(transcript.serialize()).not.toContain("fixture-auth-token");
    expect(replayTranscript(transcript.snapshot()).logicalTime).toBeGreaterThan(0);
    authority.dispose();
    expect(authority.state).toBe("disposed");
  });

  it("composes MessagePort and requires a fresh authentication baseline on reconnect", async () => {
    const first = track(createOrpcFixture({ sessionGeneration: 1, parentEpoch: 1, revision: 3 }));
    const authority = createSession({}, "electron");
    const firstTransport = new MessagePortTransport(first.clientMessagePort, 2_048);
    await authority.connect(firstTransport);
    await expect(authority.invoke("profile.refresh")).resolves.toMatchObject({
      parentEpoch: 1,
      revision: 3,
      sessionGeneration: 1,
    });
    authority.disconnect();
    expect(authority.state).toBe("disconnected");
    expect(firstTransport.readyState).toBe(3);

    const recovered = track(
      createOrpcFixture({ sessionGeneration: 2, parentEpoch: 2, revision: 4 }),
    );
    await expect(
      authority.reconnect(new MessagePortTransport(recovered.clientMessagePort, 2_048)),
    ).resolves.toMatchObject({
      parentEpoch: 2,
      revision: 4,
      sessionGeneration: 2,
    });
    await expect(authority.invoke("status.snapshot")).resolves.toMatchObject({
      correlationId: "orpc-correlation-0004",
      parentEpoch: 2,
      revision: 4,
      sessionGeneration: 2,
    });
  });

  it("rejects authentication and exact protocol-version mismatches", async () => {
    const unauthorized = track(createOrpcFixture());
    const wrongToken = new OrpcSessionAuthority({
      authToken: "wrong-auth-token",
      clientName: "web",
      clientVersion: "test-client",
    });
    await expect(
      wrongToken.connect(new WebSocketTransport(unauthorized.clientWebSocket)),
    ).rejects.toMatchObject({ kind: "unauthorized" });

    const wrongVersion = track(createOrpcFixture({ protocolVersion: 2 }));
    const client = createSession();
    await expect(
      client.connect(new WebSocketTransport(wrongVersion.clientWebSocket)),
    ).rejects.toMatchObject({ kind: "version-mismatch" });
  });

  it.each([
    ["correlation", { staleInvoke: "correlation" as const }],
    ["generation", { staleInvoke: "generation" as const }],
    ["parent epoch", { staleInvoke: "parent-epoch" as const }],
    ["revision", { staleInvoke: "revision" as const }],
  ])("rejects stale unary identity by %s", async (_name, options) => {
    const fixture = track(createOrpcFixture(options));
    const authority = createSession();
    await authority.connect(new WebSocketTransport(fixture.clientWebSocket));
    await expect(authority.invoke("status.snapshot")).rejects.toMatchObject({
      kind: "stale-response",
    });
    expect(authority.state).toBe("connected-current");
  });

  it("rejects a pending operation when the connection is replaced", async () => {
    const fixture = track(createOrpcFixture({ deferInvocations: true }));
    const authority = createSession();
    await authority.connect(new WebSocketTransport(fixture.clientWebSocket));
    const invocation = authority.invoke("status.snapshot");
    await Promise.resolve();
    authority.disconnect();
    await expect(invocation).rejects.toMatchObject({ kind: "disconnected" });
    fixture.releaseInvocations();
  });

  it("rejects stale event identity, generation, parent epoch, revision, and sequence", async () => {
    const identity = track(
      createOrpcFixture({
        eventValues: [{ sequence: 1, value: "ready", correlationId: "orpc-correlation-9999" }],
      }),
    );
    const identityAuthority = createSession();
    await identityAuthority.connect(new WebSocketTransport(identity.clientWebSocket));
    const identityEvents = await identityAuthority.watchEvents();
    await expect(identityEvents.next()).rejects.toMatchObject({ kind: "stale-response" });

    const parent = track(
      createOrpcFixture({ eventValues: [{ sequence: 1, value: "ready", parentEpoch: 2 }] }),
    );
    const parentAuthority = createSession();
    await parentAuthority.connect(new WebSocketTransport(parent.clientWebSocket));
    const parentEvents = await parentAuthority.watchEvents();
    await expect(parentEvents.next()).rejects.toMatchObject({
      kind: "stale-response",
      staleReason: "parent-epoch",
    });

    const revision = track(
      createOrpcFixture({ eventValues: [{ sequence: 1, value: "ready", revision: 2 }] }),
    );
    const revisionAuthority = createSession();
    await revisionAuthority.connect(new WebSocketTransport(revision.clientWebSocket));
    const revisionEvents = await revisionAuthority.watchEvents();
    await expect(revisionEvents.next()).rejects.toMatchObject({
      kind: "stale-response",
      staleReason: "revision",
    });

    const generation = track(
      createOrpcFixture({ eventValues: [{ sequence: 1, value: "ready", sessionGeneration: 2 }] }),
    );
    const generationAuthority = createSession();
    await generationAuthority.connect(new WebSocketTransport(generation.clientWebSocket));
    const generationEvents = await generationAuthority.watchEvents();
    await expect(generationEvents.next()).rejects.toMatchObject({
      kind: "stale-response",
      staleReason: "generation",
    });

    const sequence = track(
      createOrpcFixture({
        eventValues: [
          { sequence: 1, value: "ready" },
          { sequence: 1, value: "changed" },
        ],
      }),
    );
    const sequenceAuthority = createSession();
    await sequenceAuthority.connect(new WebSocketTransport(sequence.clientWebSocket));
    const sequenceEvents = await sequenceAuthority.watchEvents();
    await expect(sequenceEvents.next()).resolves.toMatchObject({ done: false });
    await expect(sequenceEvents.next()).rejects.toMatchObject({ kind: "stale-response" });
  });

  it("enforces positive bounded deadlines and caller cancellation", async () => {
    const scheduler = new ManualScheduler();
    const fixture = track(createOrpcFixture({ deferInvocations: true }));
    const authority = createSession({ scheduler, maxDeadlineMs: 100 });
    await authority.connect(new WebSocketTransport(fixture.clientWebSocket));
    const invocation = authority.invoke("status.snapshot", { deadlineMs: 10 });
    await flushMicrotasks();
    scheduler.fireAll();
    await expect(invocation).rejects.toMatchObject({ kind: "deadline-exceeded" });
    await flushMicrotasks();
    expect(fixture.metrics.abortCount).toBeGreaterThan(0);

    const caller = new AbortController();
    const cancelled = authority.invoke("profile.refresh", {
      deadlineMs: 20,
      signal: caller.signal,
    });
    caller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    fixture.releaseInvocations();
    await expect(authority.invoke("status.snapshot", { deadlineMs: 0 })).rejects.toBeInstanceOf(
      OrpcSessionError,
    );

    const invalidHandshakeDeadline = track(createOrpcFixture());
    const invalidHandshakeAuthority = createSession({ maxDeadlineMs: 100 });
    await expect(
      invalidHandshakeAuthority.connect(
        new WebSocketTransport(invalidHandshakeDeadline.clientWebSocket),
        { deadlineMs: 101 },
      ),
    ).rejects.toMatchObject({ kind: "deadline-exceeded" });
  });

  it("cleans event iterators idempotently and keeps transport cleanup bounded", async () => {
    const fixture = track(createOrpcFixture({ holdEventsUntilAbort: true }));
    const authority = createSession();
    await authority.connect(new WebSocketTransport(fixture.clientWebSocket));
    const events = await authority.watchEvents();
    const pendingNext = events.next();
    await flushMicrotasks(8);
    const firstReturn = events.return?.();
    const secondReturn = events.return?.();
    await expect(firstReturn).resolves.toMatchObject({ done: true });
    await expect(secondReturn).resolves.toMatchObject({ done: true });
    await expect(pendingNext).resolves.toMatchObject({ done: true });
    expect(fixture.metrics.activeStreams).toBe(0);
    expect(fixture.metrics.cleanupCount).toBe(1);
    authority.dispose();
    authority.dispose();
    expect(authority.state).toBe("disposed");
  });

  it("only shrinks negotiated message limits and closes on oversized send", async () => {
    const fixture = track(createOrpcFixture({ maxMessageBytes: 256 }));
    const authority = createSession({ maxMessageBytes: 2_048 });
    const transport = new WebSocketTransport(fixture.clientWebSocket, 2_048);
    await authority.connect(transport);
    expect(transport.maxMessageBytes).toBe(256);
    expect(() => transport.send("x".repeat(257))).toThrow("message-too-large");
    expect(authority.state).toBe("disconnected");
    expect(fixture.metrics.receivedOperations).not.toContain("/application/invoke");
  });

  it("rejects reused generation or parent epoch during reconnect", async () => {
    const first = track(createOrpcFixture({ sessionGeneration: 3, parentEpoch: 3 }));
    const authority = createSession();
    await authority.connect(new WebSocketTransport(first.clientWebSocket));
    authority.disconnect();

    const staleGeneration = track(createOrpcFixture({ sessionGeneration: 3, parentEpoch: 4 }));
    await expect(
      authority.reconnect(new WebSocketTransport(staleGeneration.clientWebSocket)),
    ).rejects.toMatchObject({ kind: "stale-response" });

    const staleParent = track(createOrpcFixture({ sessionGeneration: 4, parentEpoch: 3 }));
    await expect(
      authority.reconnect(new WebSocketTransport(staleParent.clientWebSocket)),
    ).rejects.toMatchObject({ kind: "stale-response" });

    const staleRevision = track(
      createOrpcFixture({ sessionGeneration: 5, parentEpoch: 5, revision: 1 }),
    );
    await expect(
      authority.reconnect(new WebSocketTransport(staleRevision.clientWebSocket)),
    ).rejects.toMatchObject({ kind: "stale-response", staleReason: "revision" });
  });

  it("keeps transcript schema private and replay deterministic", () => {
    const transcript = new BoundedTranscript({ maxEvents: 2 });
    const privateTranscript = new BoundedTranscript({ maxEvents: 2 });
    privateTranscript.record({
      connectionEpoch: 1,
      correlationId: "orpc-correlation-0001",
      effect: "result",
      operation: "session.handshake",
      parentEpoch: 1,
      revision: 1,
      result: "accepted",
      sessionGeneration: 1,
      transport: "message-port",
      body: "secret-body",
    } as unknown as Parameters<BoundedTranscript["record"]>[0]);
    expect(privateTranscript.serialize()).not.toContain("secret-body");
    for (const result of ["accepted", "stale", "cancelled"] as const) {
      transcript.record({
        connectionEpoch: 1,
        correlationId: "orpc-correlation-0001",
        effect: "result",
        operation: "application.events.watch",
        parentEpoch: 1,
        revision: 1,
        result,
        sessionGeneration: 1,
        transport: "message-port",
      });
    }
    expect(transcript.snapshot()).toHaveLength(2);
    expect(transcript.snapshot()[0]).toMatchObject({
      authority: "mish-orpc-session",
      logicalTime: 2,
      schemaVersion: 1,
    });
    expect(transcript.serialize()).not.toContain("fixture-auth-token");
    expect(() =>
      replayTranscript([{ ...transcript.snapshot()[0], body: "secret-body" } as never]),
    ).toThrow("Invalid oRPC transcript fields");
    expect(replayTranscript(transcript.snapshot())).toEqual({
      events: transcript.snapshot(),
      logicalTime: 3,
    });
  });

  it("keeps production source isolated from private resolvers and old envelopes", async () => {
    const paths = await sourceFiles(join(process.cwd(), "src"));
    const source = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
    expect(source).not.toContain("poc/");
    expect(source).not.toContain(".pnpm");
    expect(source).not.toContain("node_modules");
    expect(source).not.toContain("/dist/");
    expect(source).not.toContain("JSON-RPC");
    expect(source).not.toContain("jsonrpc");
    expect(source).not.toContain("dual-write");
  });
});
