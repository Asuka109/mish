import { describe, expect, it } from "vitest";
import { ApplicationSnapshotAcceptance } from "./application-snapshot-acceptance";

interface Snapshot {
  applicationOrder: {
    authorityId: string;
    epoch: number;
    order: number;
  };
  value: string;
}

function snapshot(authorityId: string, epoch: number, order: number, value: string): Snapshot {
  return { applicationOrder: { authorityId, epoch, order }, value };
}

describe("ApplicationSnapshotAcceptance", () => {
  it("rejects S1 after S2 and a retired epoch after replacement", () => {
    const acceptance = new ApplicationSnapshotAcceptance<Snapshot>();
    expect(acceptance.accept(snapshot("app", 1, 2, "S2"), "update").kind).toBe("accepted");
    expect(acceptance.accept(snapshot("app", 1, 1, "S1"), "request").kind).toBe("stale");
    expect(acceptance.accept(snapshot("app", 2, 1, "B"), "update").kind).toBe("accepted");
    expect(acceptance.accept(snapshot("app", 1, 3, "A"), "update").kind).toBe("stale");
    expect(acceptance.snapshot()?.value).toBe("B");
  });

  it("makes duplicates idempotent and rejects equal-order content conflicts", () => {
    const acceptance = new ApplicationSnapshotAcceptance<Snapshot>();
    const first = snapshot("app", 1, 1, "same");
    expect(acceptance.accept(first, "baseline").kind).toBe("accepted");
    expect(acceptance.accept(structuredClone(first), "update").kind).toBe("duplicate");
    expect(acceptance.accept(snapshot("app", 1, 1, "different"), "update").kind).toBe("conflict");
    expect(acceptance.snapshot()?.value).toBe("same");
  });

  it("allows only a baseline to replace a process authority", () => {
    const acceptance = new ApplicationSnapshotAcceptance<Snapshot>();
    acceptance.accept(snapshot("A", 1, 1, "A"), "baseline");
    expect(acceptance.accept(snapshot("B", 1, 1, "B"), "request").kind).toBe("stale");
    expect(acceptance.accept(snapshot("B", 1, 1, "B"), "baseline").kind).toBe("accepted");
    expect(acceptance.accept(snapshot("A", 9, 9, "late A"), "request").kind).toBe("stale");
  });

  it("lets the first valid post-reconnect read establish a new authority once", () => {
    const acceptance = new ApplicationSnapshotAcceptance<Snapshot>();
    acceptance.accept(snapshot("A", 1, 2, "A2"), "baseline");
    acceptance.armReconnect();

    expect(acceptance.accept(snapshot("A", 1, 1, "stale A1"), "request").kind).toBe("stale");
    expect(acceptance.isReconnectPending()).toBe(true);
    expect(acceptance.accept(snapshot("B", 1, 1, "B1"), "request").kind).toBe("accepted");
    expect(acceptance.isReconnectPending()).toBe(false);
    expect(acceptance.accept(snapshot("A", 9, 9, "late A"), "command").kind).toBe("stale");
    expect(acceptance.snapshot()?.value).toBe("B1");
  });

  it("lets a post-reconnect command establish authority and requires duplicate confirmation", () => {
    const acceptance = new ApplicationSnapshotAcceptance<Snapshot>();
    const first = snapshot("A", 1, 1, "A1");
    acceptance.accept(first, "baseline");
    acceptance.armReconnect();
    expect(acceptance.accept(structuredClone(first), "request").kind).toBe("duplicate");
    expect(acceptance.isReconnectPending()).toBe(true);
    acceptance.completeReconnect();
    expect(acceptance.isReconnectPending()).toBe(false);

    acceptance.armReconnect();
    expect(acceptance.accept(snapshot("B", 1, 1, "B1"), "command").kind).toBe("accepted");
    expect(acceptance.accept(snapshot("A", 2, 2, "late A"), "request").kind).toBe("stale");
  });

  it("does not let a normalized stale duplicate clear a provider reconnect barrier", () => {
    const client = new ApplicationSnapshotAcceptance<Snapshot>();
    const provider = new ApplicationSnapshotAcceptance<Snapshot>();
    const authorityA = snapshot("A", 1, 2, "A2");
    client.accept(authorityA, "baseline");
    provider.accept(authorityA, "baseline");
    client.armReconnect();
    provider.armReconnect();

    const normalized = client.accept(snapshot("A", 1, 1, "stale A1"), "request");
    expect(normalized.kind).toBe("stale");
    expect(provider.accept(normalized.snapshot, "request").kind).toBe("duplicate");
    expect(provider.isReconnectPending()).toBe(true);

    const authorityB = client.accept(snapshot("B", 1, 1, "B1"), "request");
    client.confirmReconnect();
    provider.confirmReconnect();
    expect(provider.accept(authorityB.snapshot, "request").kind).toBe("accepted");
    expect(provider.snapshot()?.value).toBe("B1");
  });
});
