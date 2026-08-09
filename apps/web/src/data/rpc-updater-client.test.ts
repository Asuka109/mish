import { describe, expect, it } from "vitest";
import {
  mishRpcMethods,
  UpdaterSnapshotSchema,
  type UpdaterSnapshotDto,
  type UpdaterSnapshotNotificationDto,
} from "@mish/contracts";
import { RpcClient, type RpcConnectionState } from "@mish/rpc-client";
import { RpcUpdaterClient } from "./rpc-updater-client";

function snapshot(revision = 0, phase: UpdaterSnapshotDto["phase"] = "idle"): UpdaterSnapshotDto {
  const candidate =
    phase === "idle" || phase === "checking"
      ? null
      : {
          artifactName: "Mish-0.1.1-alpha.2-aarch64.app.tar.gz",
          artifactSha256: "a".repeat(64),
          artifactSignatureSha256: "b".repeat(64),
          artifactSize: 48,
          channel: "alpha" as const,
          metadataSha256: "c".repeat(64),
          sourceSha: "d".repeat(40),
          version: "0.1.1-alpha.2",
        };
  return {
    authorityId: "updater-process",
    revision,
    configured: true,
    phase,
    operationId: phase === "idle" ? null : "operation-a",
    channel: phase === "idle" ? null : "alpha",
    candidate,
    progress: phase === "downloading" ? { downloadedBytes: 12, totalBytes: 48 } : null,
    resumable: false,
    terminalReason: null,
    maintenance: null,
  };
}

function recoveringSnapshot(revision: number): UpdaterSnapshotDto {
  return {
    authorityId: "updater-process",
    revision,
    configured: false,
    phase: "recovering",
    operationId: "operation-maintenance",
    channel: null,
    candidate: null,
    progress: null,
    resumable: false,
    terminalReason: null,
    maintenance: {
      reconciliation: "old-version",
      captureIntent: "restore-prior-capture",
      expectedVersion: "0.1.1",
      observedVersion: "0.1.0",
      automaticActivationAllowed: false,
    },
  };
}

class FakeUpdaterRpc {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private connection: RpcConnectionState = {
    attempt: 0,
    phase: "connected",
    stale: false,
  };
  private connectionListener: ((state: RpcConnectionState) => void) | null = null;
  private notificationListener: ((notification: UpdaterSnapshotNotificationDto) => void) | null =
    null;
  current = snapshot();
  subscriptionId = "updater-subscription";

  getConnectionState() {
    return this.connection;
  }

  onNotification(
    _method: string,
    _schema: unknown,
    listener: (notification: UpdaterSnapshotNotificationDto) => void,
  ) {
    this.notificationListener = listener;
    return () => {
      this.notificationListener = null;
    };
  }

  request(method: string, params: unknown) {
    this.requests.push({ method, params });
    if (method === "updater.subscribe") {
      return Promise.resolve({ snapshot: this.current, subscriptionId: this.subscriptionId });
    }
    if (method === "updater.unsubscribe") return Promise.resolve(true);
    return Promise.resolve(this.current);
  }

  subscribeConnection(listener: (state: RpcConnectionState) => void) {
    this.connectionListener = listener;
    listener(this.connection);
    return () => {
      this.connectionListener = null;
    };
  }

  emit(snapshot: UpdaterSnapshotDto) {
    this.current = snapshot;
    this.notificationListener?.({ snapshot, subscriptionId: this.subscriptionId });
  }

  reconnect() {
    this.connection = { attempt: 0, phase: "connected", stale: false };
    this.connectionListener?.(this.connection);
  }
}

function rpc(fake: FakeUpdaterRpc) {
  return fake as unknown as RpcClient<typeof mishRpcMethods>;
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("RpcUpdaterClient", () => {
  it("accepts bounded maintenance facts and rejects private journal additions", () => {
    const recovering = recoveringSnapshot(4);
    expect(UpdaterSnapshotSchema.parse(recovering)).toEqual(recovering);
    expect(UpdaterSnapshotSchema.parse(recoveringSnapshot(Number.MAX_SAFE_INTEGER))).toEqual(
      recoveringSnapshot(Number.MAX_SAFE_INTEGER),
    );
    expect(() =>
      UpdaterSnapshotSchema.parse(recoveringSnapshot(Number.MAX_SAFE_INTEGER + 1)),
    ).toThrow();
    expect(() =>
      UpdaterSnapshotSchema.parse({
        ...recovering,
        maintenance: {
          ...recovering.maintenance,
          candidatePath: "/Users/private/candidate",
          metadata: "raw-body",
        },
      }),
    ).toThrow();
  });

  it("accepts only newer authoritative revisions and reconnects without replaying commands", async () => {
    const fake = new FakeUpdaterRpc();
    const client = new RpcUpdaterClient(rpc(fake));
    const delivered: UpdaterSnapshotDto[] = [];
    client.subscribeSnapshots((next) => delivered.push(next));
    await flushMicrotasks();

    fake.emit(snapshot(2, "available"));
    fake.emit(snapshot(1, "available"));
    expect(delivered.map((next) => next.revision)).toEqual([0, 2]);

    fake.current = snapshot(2, "available");
    fake.reconnect();
    await flushMicrotasks();
    expect(fake.requests.filter(({ method }) => method === "updater.subscribe")).toHaveLength(2);
    expect(
      fake.requests.filter(({ method }) =>
        ["updater.check", "updater.download", "updater.cancel"].includes(method),
      ),
    ).toHaveLength(0);
    client.dispose();
  });

  it("sends each operation key exactly once and preserves newer subscription progress", async () => {
    const fake = new FakeUpdaterRpc();
    const client = new RpcUpdaterClient(rpc(fake));
    client.subscribeSnapshots(() => undefined);
    await flushMicrotasks();
    fake.current = snapshot(3, "checking");
    await client.check("operation-a", "alpha");
    fake.current = snapshot(4, "downloading");
    await client.download("operation-a");
    fake.emit(snapshot(5, "downloading"));
    fake.current = snapshot(4, "downloading");
    expect((await client.getSnapshot()).revision).toBe(5);
    await client.cancel("operation-a");

    expect(
      fake.requests
        .filter(({ method }) =>
          ["updater.check", "updater.download", "updater.cancel"].includes(method),
        )
        .map(({ method, params }) => [method, params]),
    ).toEqual([
      ["updater.check", { channel: "alpha", operationId: "operation-a" }],
      ["updater.download", { operationId: "operation-a" }],
      ["updater.cancel", { operationId: "operation-a" }],
    ]);
    client.dispose();
  });

  it("keeps unresolved restart recovery authoritative across stale reconnect baselines", async () => {
    const fake = new FakeUpdaterRpc();
    fake.current = recoveringSnapshot(9);
    const client = new RpcUpdaterClient(rpc(fake));
    const delivered: UpdaterSnapshotDto[] = [];
    client.subscribeSnapshots((next) => delivered.push(next));
    await flushMicrotasks();

    fake.emit(recoveringSnapshot(10));
    fake.current = recoveringSnapshot(9);
    fake.reconnect();
    await flushMicrotasks();

    expect(delivered.at(-1)).toEqual(recoveringSnapshot(10));
    expect(
      fake.requests.filter(({ method }) =>
        ["updater.check", "updater.download", "updater.cancel"].includes(method),
      ),
    ).toHaveLength(0);
    client.dispose();
  });
});
