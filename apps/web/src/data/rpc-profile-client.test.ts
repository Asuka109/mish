import { mishRpcMethods, type ProfileSnapshotDto } from "@mish/contracts";
import { RpcClient, type WebSocketLike, type WebSocketLikeEventMap } from "@mish/rpc-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcProfileClient } from "./rpc-profile-client";

class FakeTransport implements WebSocketLike {
  readonly sent: string[] = [];
  readyState = 0;
  private listeners = new Map<keyof WebSocketLikeEventMap, Set<(event: never) => void>>();

  addEventListener<Type extends keyof WebSocketLikeEventMap>(
    type: Type,
    listener: (event: WebSocketLikeEventMap[Type]) => void,
  ) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: never) => void);
    this.listeners.set(type, listeners);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }

  emit<Type extends keyof WebSocketLikeEventMap>(type: Type, event: WebSocketLikeEventMap[Type]) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  removeEventListener<Type extends keyof WebSocketLikeEventMap>(
    type: Type,
    listener: (event: WebSocketLikeEventMap[Type]) => void,
  ) {
    this.listeners.get(type)?.delete(listener as (event: never) => void);
  }

  respond(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  send(data: string) {
    this.sent.push(data);
  }
}

function profileSnapshot(activeProfileId: string | null): ProfileSnapshotDto {
  const profileId = activeProfileId ?? "profile-a";
  return {
    activation: {
      activeFingerprint: activeProfileId
        ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        : null,
      activeProfileId,
      attemptedAt: activeProfileId ? 2 : null,
      availability: "available",
      commandId: null,
      failure: null,
      operation: null,
      phase: activeProfileId ? "success" : "idle",
      safeStopped: activeProfileId === null,
      startupPolicy: "safe-stopped",
      targetProfileId: null,
    },
    adapterKind: "rpc",
    capabilities: {
      activation: "supported",
      deletion: "supported",
      httpsImport: "supported",
      localFileImport: "permission-required",
      refresh: "supported",
      save: "supported",
    },
    profiles: [
      {
        id: profileId,
        label: "Synthetic profile",
        lastAttempt: null,
        lastKnownValid: true,
        lastSuccessAt: 1,
        source: { display: "synthetic.yaml", sourceType: "local-file" },
        status: {
          active: activeProfileId === profileId,
          error: false,
          stale: false,
          updating: false,
          valid: true,
          warning: false,
        },
        runtimeProvenance: {
          artifactFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          authority: "desktop-policy",
          items: [],
          layers: ["source", "application-policy", "platform-integration", "effective-runtime"],
          sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          unknownKeyCount: 0,
        },
        warningCodes: [],
      },
    ],
  };
}

async function waitForRequest(transport: FakeTransport, index: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.sent[index]) return JSON.parse(transport.sent[index]);
    await Promise.resolve();
  }
  throw new Error(`RPC request ${index} was not sent`);
}

async function authenticate(transport: FakeTransport) {
  transport.open();
  const request = await waitForRequest(transport, 0);
  transport.respond({
    id: request.id,
    jsonrpc: "2.0",
    result: { authenticated: true, sessionId: "rpc-session" },
  });
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("RpcProfileClient", () => {
  it("resubscribes with the authoritative activation snapshot after reconnect", async () => {
    vi.useFakeTimers();
    const transports = [new FakeTransport(), new FakeTransport()];
    let transportIndex = 0;
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      backoff: { initialDelayMilliseconds: 5, maximumReconnectAttempts: 1 },
      methods: mishRpcMethods,
      transportFactory: () => transports[transportIndex++],
    });
    const client = new RpcProfileClient(rpc, async () => null);
    const snapshots: ProfileSnapshotDto[] = [];
    const states: string[] = [];
    client.subscribeSnapshots((snapshot) => snapshots.push(snapshot));
    client.subscribeConnection((state) => states.push(`${state.phase}:${state.stale}`));

    await authenticate(transports[0]);
    const firstSubscribe = await waitForRequest(transports[0], 1);
    transports[0].respond({
      id: firstSubscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: profileSnapshot(null), subscriptionId: "profiles-1" },
    });
    await flushMicrotasks();
    expect(snapshots.at(-1)?.activation.safeStopped).toBe(true);

    transports[0].close(1006, "gap");
    expect(states.at(-1)).toContain("true");
    await vi.advanceTimersByTimeAsync(5);
    await authenticate(transports[1]);
    const secondSubscribe = await waitForRequest(transports[1], 1);
    transports[1].respond({
      id: secondSubscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: profileSnapshot("profile-b"), subscriptionId: "profiles-2" },
    });
    await flushMicrotasks();

    expect(snapshots.at(-1)?.activation.activeProfileId).toBe("profile-b");
    expect(states.at(-1)).toBe("connected:false");
    client.dispose();
    rpc.dispose();
  });
});
