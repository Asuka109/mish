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
      patches: "supported",
      refresh: "supported",
      scheduling: "supported",
      save: "supported",
    },
    profiles: [
      {
        effectiveFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        id: profileId,
        label: "Synthetic profile",
        lastAttempt: null,
        lastKnownValid: true,
        lastSuccessAt: 1,
        refresh: {
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastSuccessAt: null,
          nextRunAt: null,
          policy: "off",
        },
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
          layers: [
            "source",
            "user-patches",
            "application-policy",
            "platform-integration",
            "effective-runtime",
          ],
          sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          unknownKeyCount: 0,
        },
        warningCodes: [],
      },
    ],
    providers: {
      authority: null,
      capability: "unavailable",
      observationFailure: null,
      observedAt: null,
      providers: [],
      remotelyCancellable: false,
    },
    selection: { profileId, revision: 1 },
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
  it("masks native local import for a browser RPC client", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcProfileClient(rpc, null);
    const snapshots: ProfileSnapshotDto[] = [];
    client.subscribeSnapshots((snapshot) => snapshots.push(snapshot));

    await authenticate(transport);
    const subscribe = await waitForRequest(transport, 1);
    transport.respond({
      id: subscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: profileSnapshot(null), subscriptionId: "profiles-browser" },
    });
    await flushMicrotasks();

    expect(snapshots.at(-1)?.capabilities.localFileImport).toBe("unavailable");
    await expect(client.preflightLocal()).rejects.toMatchObject({ code: "unsupported" });

    const refreshPromise = client.refreshProfile("profile-a");
    const refresh = await waitForRequest(transport, 2);
    transport.respond({ id: refresh.id, jsonrpc: "2.0", result: profileSnapshot(null) });
    expect((await refreshPromise).capabilities.localFileImport).toBe("unavailable");
    client.dispose();
    rpc.dispose();
  });

  it("sends only fixed refresh policy and provider authority fields", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcProfileClient(rpc, async () => null);
    const schedulePromise = client.setRefreshPolicy("profile-a", "six-hours");
    await authenticate(transport);
    const schedule = await waitForRequest(transport, 1);
    expect(schedule).toMatchObject({
      method: "profiles.setRefreshPolicy",
      params: { policy: "six-hours", profileId: "profile-a" },
    });
    transport.respond({ id: schedule.id, jsonrpc: "2.0", result: profileSnapshot(null) });
    await schedulePromise;

    const authority = {
      profileId: "profile-a",
      runtimeFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const updatePromise = client.updateProvider(authority, "provider:a");
    const update = await waitForRequest(transport, 2);
    expect(update).toMatchObject({
      method: "profiles.updateProvider",
      params: { authority, providerId: "provider:a" },
    });
    transport.respond({
      id: update.id,
      jsonrpc: "2.0",
      result: {
        failed: [],
        failure: "disconnected",
        operation: "update-one",
        phase: "failure",
        snapshot: profileSnapshot(null).providers,
        succeededProviderIds: [],
      },
    });
    expect((await updatePromise).phase).toBe("failure");

    const patchAuthority = {
      artifactFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      profileId: "profile-a",
      sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const patchEditor = {
      activationBlocked: false,
      authority: patchAuthority,
      catalog: { groups: [], outbounds: [], ruleProviders: [], rules: [] },
      effectiveFingerprint: patchAuthority.artifactFingerprint,
      patches: [],
      schemaVersion: 1,
    };
    const getPatchesPromise = client.getPatches(patchAuthority);
    const getPatches = await waitForRequest(transport, 3);
    expect(getPatches).toMatchObject({ method: "profiles.getPatches", params: patchAuthority });
    transport.respond({ id: getPatches.id, jsonrpc: "2.0", result: patchEditor });
    await getPatchesPromise;

    const getRoutesPromise = client.getRoutes("profile-a");
    const getRoutes = await waitForRequest(transport, 4);
    expect(getRoutes).toMatchObject({
      method: "profiles.getRoutes",
      params: { profileId: "profile-a" },
    });
    transport.respond({
      id: getRoutes.id,
      jsonrpc: "2.0",
      result: {
        fingerprint: patchAuthority.artifactFingerprint,
        groups: [],
        nodes: [],
        profileId: "profile-a",
        routingMode: "rule",
      },
    });
    await getRoutesPromise;

    const replacePatchesPromise = client.replacePatches(patchAuthority, []);
    const replacePatches = await waitForRequest(transport, 5);
    expect(replacePatches).toMatchObject({
      method: "profiles.replacePatches",
      params: { authority: patchAuthority, patches: [], schemaVersion: 1 },
    });
    transport.respond({ id: replacePatches.id, jsonrpc: "2.0", result: patchEditor });
    await replacePatchesPromise;

    const openDirectoryPromise = client.openProfileDirectory();
    const openDirectory = await waitForRequest(transport, 6);
    expect(openDirectory).toMatchObject({ method: "profiles.openDirectory", params: {} });
    transport.respond({ id: openDirectory.id, jsonrpc: "2.0", result: true });
    await openDirectoryPromise;

    const createPromise = client.createProfile("new-profile.yaml");
    const create = await waitForRequest(transport, 7);
    expect(create).toMatchObject({
      method: "profiles.create",
      params: { fileName: "new-profile.yaml" },
    });
    transport.respond({ id: create.id, jsonrpc: "2.0", result: profileSnapshot(null) });
    await createPromise;

    const expectedSelection = { profileId: "profile-b", revision: 4 };
    const selectPromise = client.selectProfile("profile-a", { expectedSelection });
    const select = await waitForRequest(transport, 8);
    expect(select).toMatchObject({
      method: "profiles.select",
      params: { expectedSelection, profileId: "profile-a" },
    });
    const selected = profileSnapshot(null);
    selected.selection.revision = 2;
    transport.respond({ id: select.id, jsonrpc: "2.0", result: selected });
    expect((await selectPromise).selection).toEqual({ profileId: "profile-a", revision: 2 });

    client.dispose();
    rpc.dispose();
  });

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
    const reconnectSnapshot = profileSnapshot("profile-b");
    reconnectSnapshot.selection.revision = 4;
    transports[1].respond({
      id: secondSubscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: reconnectSnapshot, subscriptionId: "profiles-2" },
    });
    await flushMicrotasks();

    expect(snapshots.at(-1)?.activation.activeProfileId).toBe("profile-b");
    expect(snapshots.at(-1)?.selection).toEqual({ profileId: "profile-b", revision: 4 });
    expect(states.at(-1)).toBe("connected:false");
    client.dispose();
    rpc.dispose();
  });

  it("accepts the backend capture activation failure without dropping the profile update", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcProfileClient(rpc, async () => null);
    const snapshots: ProfileSnapshotDto[] = [];
    client.subscribeSnapshots((snapshot) => snapshots.push(snapshot));

    await authenticate(transport);
    const subscribe = await waitForRequest(transport, 1);
    transport.respond({
      id: subscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: profileSnapshot(null), subscriptionId: "profiles-capture" },
    });
    await flushMicrotasks();

    const failed = profileSnapshot(null) as unknown as {
      activation: Record<string, unknown>;
    };
    failed.activation = {
      ...failed.activation,
      attemptedAt: 3,
      commandId: "11111111-1111-4111-8111-111111111111",
      failure: "capture",
      operation: "activate",
      phase: "failure",
      targetProfileId: "profile-a",
    };
    transport.respond({
      jsonrpc: "2.0",
      method: "profiles.snapshot",
      params: { snapshot: failed, subscriptionId: "profiles-capture" },
    });
    await flushMicrotasks();

    expect(snapshots.at(-1)?.activation.failure).toBe("capture");
    client.dispose();
    rpc.dispose();
  });
});
