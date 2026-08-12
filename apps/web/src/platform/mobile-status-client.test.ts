import { describe, expect, it, vi } from "vitest";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { MobileStatusClient } from "./mobile-status-client";

async function routeEnvelope(
  order: number,
  selectedChildId = "hkg-02",
  authority = "mobile-runtime-a",
) {
  const status = await new FixtureStatusClient().getSnapshot();
  status.adapterKind = "native";
  status.activeProfileId = "profile-a";
  status.applicationOrder = { authorityId: authority, epoch: 3, order };
  const group = status.groups.find((candidate) => candidate.id === "proxy");
  if (!group) throw new Error("Fixture selector is missing");
  group.selectedChildId = selectedChildId;
  return {
    contractVersion: 1 as const,
    profileId: "profile-a",
    profileRevision: "revision-a",
    runtimeAuthority: authority,
    status,
  };
}

describe("MobileStatusClient", () => {
  it("uses the complete baseline authority and accepts the ordered command snapshot", async () => {
    const baseline = await routeEnvelope(1);
    const selected = await routeEnvelope(2, "hkg-01");
    selected.status.groupSelectionOperation = {
      ...selected.status.groupSelectionOperation,
      catalogRevision: "a".repeat(64),
      cleanupPhase: "skipped",
      membershipRevision: "a".repeat(64),
      operationId: "route-fixed",
      selectionConfirmed: true,
    };
    const invoke = vi.fn(async (command: string) =>
      command === "get_route_snapshot"
        ? baseline
        : {
            contractVersion: 1,
            failure: null,
            operationId: "route-fixed",
            snapshot: selected,
            status: "success",
          },
    );
    const client = new MobileStatusClient({ invoke }, () => "route-fixed");

    await client.getSnapshot();
    const result = await client.selectGroupChild("proxy", "hkg-01");

    expect(result.groups.find((group) => group.id === "proxy")?.selectedChildId).toBe("hkg-01");
    expect(invoke).toHaveBeenLastCalledWith("select_route_child", {
      request: {
        childId: "hkg-01",
        currentChildId: "hkg-02",
        groupId: "proxy",
        operationId: "route-fixed",
        profileId: "profile-a",
        profileRevision: "revision-a",
        runtimeAuthority: "mobile-runtime-a",
      },
    });
  });

  it("cancels before dispatch when the AbortSignal is already aborted", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "get_route_snapshot") return routeEnvelope(1);
      if (command === "cancel_route_selection") {
        return { accepted: true, contractVersion: 1, operationId: "route-cancel" };
      }
      throw new Error("selection effect must not run");
    });
    const client = new MobileStatusClient({ invoke }, () => "route-cancel");
    await client.getSnapshot();
    const abort = new AbortController();
    abort.abort();

    await expect(
      client.selectGroupChild("proxy", "hkg-01", { signal: abort.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "get_route_snapshot",
      "cancel_route_selection",
    ]);
  });

  it("retires a delayed stale command after a replacement baseline", async () => {
    const oldBaseline = await routeEnvelope(1);
    const replacement = await routeEnvelope(1, "hkg-02", "mobile-runtime-b");
    const oldResult = await routeEnvelope(2, "hkg-01");
    let resolveSelection!: (value: unknown) => void;
    const selection = new Promise((resolve) => {
      resolveSelection = resolve;
    });
    let baselineCalls = 0;
    const invoke = vi.fn((command: string) => {
      if (command === "get_route_snapshot") {
        return Promise.resolve(baselineCalls++ === 0 ? oldBaseline : replacement);
      }
      return selection;
    });
    const client = new MobileStatusClient({ invoke }, () => "route-delayed");
    await client.getSnapshot();
    const pending = client.selectGroupChild("proxy", "hkg-01");
    await client.getSnapshot();
    resolveSelection({
      contractVersion: 1,
      failure: null,
      operationId: "route-delayed",
      snapshot: oldResult,
      status: "success",
    });

    await expect(pending).rejects.toMatchObject({ code: "runtime-replaced" });
    expect((await client.getSnapshot()).applicationOrder.authorityId).toBe("mobile-runtime-b");
  });

  it("keeps the accepted baseline when a delayed refresh has an older order", async () => {
    const current = await routeEnvelope(2, "hkg-01");
    const delayed = await routeEnvelope(1, "hkg-02");
    let calls = 0;
    const client = new MobileStatusClient({
      invoke: vi.fn(async () => (calls++ === 0 ? current : delayed)),
    });

    await client.getSnapshot();
    const refreshed = await client.getSnapshot();

    expect(refreshed.applicationOrder.order).toBe(2);
    expect(refreshed.groups.find((group) => group.id === "proxy")?.selectedChildId).toBe("hkg-01");
  });

  it("rejects malformed or inconsistent native envelopes without publishing them", async () => {
    const baseline = await routeEnvelope(1);
    const listener = vi.fn();
    const client = new MobileStatusClient({
      invoke: vi.fn(async () => ({ ...baseline, runtimeAuthority: "wrong-runtime" })),
    });
    client.subscribeSnapshots(listener);

    await expect(client.getSnapshot()).rejects.toMatchObject({ code: "protocol" });
    expect(listener).not.toHaveBeenCalled();
  });
});
