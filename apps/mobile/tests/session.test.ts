import { describe, expect, it } from "vitest";

import { createQueryClient } from "@mish/ui-state";
import { WebSocketTransport } from "@mish/orpc-client";
import type { OrpcEventValue } from "@mish/contracts";
import {
  createOrpcFixture,
  type OrpcFixture,
} from "../../../packages/orpc-client/tests/support/orpc-fixture.js";

import {
  RN_SESSION_STREAM_QUERY_KEY,
  createRnSessionActor,
  reduceRnSessionEvent,
  snapshotPhase,
} from "../src/session.js";

const flush = async (turns = 64): Promise<void> => {
  await Array.from({ length: turns }, () => undefined).reduce(
    (promise) => promise.then(() => undefined),
    Promise.resolve(),
  );
};

describe("RN host session seam", () => {
  it("accepts handshake and invocation through the shared oRPC fixture, then cleans the stream", async () => {
    const fixtures: OrpcFixture[] = [];
    const queryClient = createQueryClient({ queryRetry: 0, mutationRetry: 0 });
    const session = createRnSessionActor({
      authToken: "fixture-auth-token",
      queryClient,
      openTransport: async () => {
        const fixture = createOrpcFixture({ holdEventsUntilAbort: true });
        fixtures.push(fixture);
        return new WebSocketTransport(fixture.clientWebSocket, 4_096);
      },
    });

    session.actor.start();
    let resolveConnected!: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const subscription = session.actor.subscribe((snapshot) => {
      if (snapshotPhase(snapshot) === "connected") resolveConnected();
    });
    session.actor.send({ type: "CONNECT" });
    await connected;
    subscription.unsubscribe();

    expect(snapshotPhase(session.actor.getSnapshot())).toBe("connected");
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.metrics.handshakeClientNames).toEqual(["react-native"]);
    await expect(session.authority.invoke("status.snapshot")).resolves.toEqual({
      correlationId: "orpc-correlation-0003",
      operation: "status.snapshot",
      parentEpoch: 1,
      revision: 1,
      sessionGeneration: 1,
      value: "accepted",
    });
    await flush();
    expect(fixtures[0]?.metrics.receivedOperations).toContain("/application/invoke");

    await session.dispose();
    await flush();
    expect(session.actor.getSnapshot().status).toBe("stopped");
    expect(fixtures[0]?.metrics.activeStreams).toBe(0);
    expect(fixtures[0]?.metrics.cleanupCount).toBeGreaterThanOrEqual(1);
    expect(fixtures[0]?.metrics.abortCount).toBeGreaterThanOrEqual(1);
    expect(queryClient.getQueryData(RN_SESSION_STREAM_QUERY_KEY)).toBeUndefined();
    for (const fixture of fixtures) fixture.close();
  });

  it("keeps stale generation, epoch, revision, and sequence events out of Query", () => {
    const current: OrpcEventValue = {
      correlationId: "fixture-correlation-1",
      parentEpoch: 2,
      revision: 3,
      sequence: 2,
      sessionGeneration: 4,
      value: "changed",
    };
    const previous = reduceRnSessionEvent(undefined, current);

    expect(reduceRnSessionEvent(previous, { ...current, sessionGeneration: 3, sequence: 3 })).toBe(
      previous,
    );
    expect(reduceRnSessionEvent(previous, { ...current, parentEpoch: 1, sequence: 3 })).toBe(
      previous,
    );
    expect(reduceRnSessionEvent(previous, { ...current, revision: 2, sequence: 3 })).toBe(previous);
    expect(reduceRnSessionEvent(previous, { ...current, sequence: 1 })).toBe(previous);
  });
});
