import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BoundedTranscript } from "../src/transcript.js";
import {
  BoundedMessagePortChannel,
  BoundedWebSocketChannel,
  PolicySession,
  PolicyTransportError,
  type DeadlineScheduler,
} from "../src/transport.js";
import { createOrpcFixture } from "./support/orpc-peer.js";

const fixtures: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function track<T extends { close: () => void }>(fixture: T): T {
  fixtures.push(fixture);
  return fixture;
}

function session(
  authToken = "fixture-token",
  options: Partial<ConstructorParameters<typeof PolicySession>[0]> = {},
  clientName: "web" | "electron" = "web",
): PolicySession {
  return new PolicySession({
    ...options,
    authToken,
    clientName,
    clientVersion: "poc-test",
    maxMessageBytes: options.maxMessageBytes ?? 2048,
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

describe("oRPC policy and transport admission POC", () => {
  it("uses the WebSocket adapter for authenticated contract calls and event cleanup", async () => {
    const fixture = track(createOrpcFixture({ maxMessageBytes: 512 }));
    const transcript = new BoundedTranscript({ transport: "websocket", maxEvents: 32 });
    const client = session("fixture-token", { transcript });
    const channel = new BoundedWebSocketChannel(fixture.clientWebSocket, 2048);

    await expect(client.connect(channel)).resolves.toMatchObject({
      protocolVersion: 1,
      sessionGeneration: 1,
      maxMessageBytes: 512,
    });
    await expect(client.invoke("status.snapshot")).resolves.toMatchObject({
      correlationId: "poc-0002",
      operation: "status.snapshot",
      sessionGeneration: 1,
      value: "ok",
    });

    const events = await client.watchEvents();
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { correlationId: "poc-0003", sequence: 1, sessionGeneration: 1, value: "ready" },
    });
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { correlationId: "poc-0003", sequence: 2, sessionGeneration: 1, value: "changed" },
    });
    await expect(events.next()).resolves.toMatchObject({ done: true });
    expect(fixture.metrics.activeStreams).toBe(0);
    expect(fixture.metrics.cleanupCount).toBe(1);
    expect(transcript.snapshot().every((event) => !("authToken" in event))).toBe(true);
    expect(transcript.serialize()).not.toContain("fixture-token");

    client.dispose();
    expect(client.state).toBe("disposed");
  });

  it("uses the Electron MessagePort adapter and recovers with a fresh session generation", async () => {
    const first = track(createOrpcFixture({ sessionGeneration: 1 }));
    const client = session("fixture-token", {}, "electron");
    await client.connect(new BoundedMessagePortChannel(first.clientMessagePort, 2048));
    await expect(client.invoke("profile.refresh")).resolves.toMatchObject({ sessionGeneration: 1 });
    client.disconnect();
    expect(client.state).toBe("disconnected");

    const recovered = track(createOrpcFixture({ sessionGeneration: 2 }));
    await expect(
      client.reconnect(new BoundedMessagePortChannel(recovered.clientMessagePort, 2048)),
    ).resolves.toMatchObject({ sessionGeneration: 2 });
    await expect(client.invoke("status.snapshot")).resolves.toMatchObject({
      sessionGeneration: 2,
      correlationId: "poc-0004",
    });
    expect(client.sessionGeneration).toBe(2);
  });

  it("rejects bad authentication and protocol-version negotiation", async () => {
    const unauthorizedFixture = track(createOrpcFixture());
    const unauthorized = session("wrong-token");
    await expect(
      unauthorized.connect(new BoundedWebSocketChannel(unauthorizedFixture.clientWebSocket, 2048)),
    ).rejects.toMatchObject({ kind: "unauthorized" });

    const versionFixture = track(createOrpcFixture({ protocolVersion: 2 }));
    const versionClient = session("fixture-token", { protocolVersion: 1 });
    await expect(
      versionClient.connect(new BoundedWebSocketChannel(versionFixture.clientWebSocket, 2048)),
    ).rejects.toMatchObject({ kind: "version-mismatch" });
  });

  it.each([
    ["correlation", { staleInvoke: "correlation" as const }],
    ["generation", { staleInvoke: "generation" as const }],
  ])("rejects a stale unary response by %s", async (_name, options) => {
    const fixture = track(createOrpcFixture(options));
    const client = session();
    await client.connect(new BoundedWebSocketChannel(fixture.clientWebSocket, 2048));
    await expect(client.invoke("status.snapshot")).rejects.toMatchObject({
      kind: "stale-response",
    });
    expect(client.state).toBe("connected");
  });

  it("rejects stale event identity and sequence without accepting it as current state", async () => {
    const identityFixture = track(
      createOrpcFixture({
        eventValues: [{ sequence: 1, value: "ready", correlationId: "poc-9999" }],
      }),
    );
    const identityClient = session();
    await identityClient.connect(
      new BoundedWebSocketChannel(identityFixture.clientWebSocket, 2048),
    );
    const identityEvents = await identityClient.watchEvents();
    await expect(identityEvents.next()).rejects.toMatchObject({ kind: "stale-response" });

    const sequenceFixture = track(
      createOrpcFixture({
        eventValues: [
          { sequence: 1, value: "ready" },
          { sequence: 1, value: "changed" },
        ],
      }),
    );
    const sequenceClient = session();
    await sequenceClient.connect(
      new BoundedWebSocketChannel(sequenceFixture.clientWebSocket, 2048),
    );
    const sequenceEvents = await sequenceClient.watchEvents();
    await expect(sequenceEvents.next()).resolves.toMatchObject({ done: false });
    await expect(sequenceEvents.next()).rejects.toMatchObject({ kind: "stale-response" });
  });

  it("propagates deadline cancellation to the peer and records a bounded result", async () => {
    const scheduler = new ManualScheduler();
    const fixture = track(createOrpcFixture({ deferInvocations: true }));
    const transcript = new BoundedTranscript({ transport: "websocket", maxEvents: 8 });
    const client = session("fixture-token", { scheduler, transcript });
    await client.connect(new BoundedWebSocketChannel(fixture.clientWebSocket, 2048));

    const invocation = client.invoke("status.snapshot", { deadlineMs: 10 });
    for (let i = 0; i < 8 && !fixture.metrics.receivedOperations.includes("/invoke"); i += 1) {
      await Promise.resolve();
    }
    scheduler.fireAll();
    await expect(invocation).rejects.toMatchObject({ kind: "deadline-exceeded" });
    for (let i = 0; i < 8 && fixture.metrics.abortCount === 0; i += 1) {
      await Promise.resolve();
    }
    expect(fixture.metrics.abortCount).toBeGreaterThan(0);
    expect(transcript.snapshot().at(-1)?.result).toBe("deadline-exceeded");
  });

  it("propagates caller AbortSignal cancellation and cleans an event iterator", async () => {
    const fixture = track(
      createOrpcFixture({ deferInvocations: true, holdEventsUntilAbort: true }),
    );
    const client = session();
    await client.connect(new BoundedWebSocketChannel(fixture.clientWebSocket, 2048));

    const controller = new AbortController();
    const invocation = client.invoke("profile.refresh", {
      signal: controller.signal,
      deadlineMs: 100,
    });
    await Promise.resolve();
    controller.abort();
    await expect(invocation).rejects.toMatchObject({ kind: "cancelled" });

    const events = await client.watchEvents();
    await events.return?.();
    expect(fixture.metrics.activeStreams).toBe(0);
    expect(fixture.metrics.cleanupCount).toBeGreaterThan(0);
    client.dispose();
  });

  it("enforces the negotiated message-size ceiling before sending", async () => {
    const fixture = track(createOrpcFixture({ maxMessageBytes: 256 }));
    const client = session();
    const channel = new BoundedWebSocketChannel(fixture.clientWebSocket, 2048);
    await client.connect(channel);

    expect(() => channel.send("x".repeat(257))).toThrowError(PolicyTransportError);
    expect(fixture.metrics.receivedOperations).not.toContain("/invoke");
    expect(client.state).toBe("disconnected");
  });

  it("rejects reconnect handshakes that reuse an old session generation", async () => {
    const first = track(createOrpcFixture({ sessionGeneration: 3 }));
    const client = session();
    await client.connect(new BoundedWebSocketChannel(first.clientWebSocket, 2048));
    client.disconnect();

    const stale = track(createOrpcFixture({ sessionGeneration: 3 }));
    await expect(
      client.reconnect(new BoundedWebSocketChannel(stale.clientWebSocket, 2048)),
    ).rejects.toMatchObject({ kind: "stale-response" });
  });

  it("keeps transcript evidence bounded and schema-versioned", () => {
    const transcript = new BoundedTranscript({ transport: "message-port", maxEvents: 2 });
    for (const result of ["accepted", "stale", "cancelled"] as const) {
      transcript.record({
        operation: "events.watch",
        effect: "result",
        result,
        correlationId: "poc-0001",
        sessionGeneration: 1,
      });
    }
    expect(transcript.snapshot()).toHaveLength(2);
    expect(transcript.snapshot()[0]).toMatchObject({
      schemaVersion: 1,
      authority: "poc",
      transport: "message-port",
      logicalTime: 2,
    });
    expect(transcript.serialize()).not.toContain("request");
  });

  it("rejects package-manager private imports in the POC source and fixtures", async () => {
    const paths = [
      ...(await sourceFiles(join(process.cwd(), "src"))),
      ...(await sourceFiles(join(process.cwd(), "tests"))),
    ];
    const source = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    const joinedSource = source.join("\n");
    const privatePackagePath = ["node_modules", ".pnpm"].join("/");
    const privateDistPath = ["", "dist", ""].join("/");
    expect(joinedSource).not.toContain(privatePackagePath);
    expect(joinedSource).not.toContain(privateDistPath);

    for (const resolverWorkaround of [
      ["create", "Require"].join(""),
      ["fileURL", "ToPath"].join(""),
      ["resolve", "P0PublicPackage"].join(""),
      ["p0Electron", "Root"].join(""),
      ["..", "..", "..", "electron"].join("/"),
    ]) {
      expect(joinedSource).not.toContain(resolverWorkaround);
    }
  });
});
