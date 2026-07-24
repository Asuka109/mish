import { act, render, waitFor } from "@testing-library/react";
import type {
  TrafficCommandAuthorityDto,
  TrafficCommandOperation,
  TrafficCommandResultDto,
} from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { FixtureTrafficClient } from "./fixture-traffic-client";
import { TrafficProvider, useTraffic } from "./traffic-provider";

let traffic: ReturnType<typeof useTraffic> | null = null;

function Probe() {
  traffic = useTraffic();
  return null;
}

class CommandTrafficClient extends FixtureTrafficClient {
  receivedAuthority: TrafficCommandAuthorityDto | null = null;

  override supportsCommand(_command: TrafficCommandOperation) {
    return true;
  }

  override async closeConnection(
    authority: TrafficCommandAuthorityDto,
    connectionId: string,
  ): Promise<TrafficCommandResultDto> {
    this.receivedAuthority = authority;
    const snapshot = await this.getSnapshot();
    const next = {
      ...snapshot,
      activeConnections: snapshot.activeConnections.filter(({ id }) => id !== connectionId),
      sequence: snapshot.sequence + 1,
    };
    this.publishSnapshot(next);
    return {
      failure: null,
      operation: "close-connection",
      remainingConnectionIds: [],
      snapshot: next,
      status: "success",
      targetCount: 1,
    };
  }
}

function renderProvider(client: FixtureTrafficClient) {
  traffic = null;
  return render(
    <TrafficProvider client={client}>
      <Probe />
    </TrafficProvider>,
  );
}

describe("TrafficProvider displayed snapshot", () => {
  it("retains current authority while one complete displayed snapshot is paused, then resumes atomically", async () => {
    const client = new FixtureTrafficClient();
    const initial = await client.getSnapshot();
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot?.sequence).toBe(initial.sequence));

    act(() => traffic?.toggleViewPause());
    act(() => {
      client.publishSnapshot({
        ...initial,
        activeConnections: initial.activeConnections.slice(0, 1),
        rules: initial.rules.slice(0, 1),
        sequence: initial.sequence + 1,
      });
    });

    expect(traffic?.isViewPaused).toBe(true);
    expect(traffic?.snapshot?.activeConnections).toHaveLength(initial.activeConnections.length);
    expect(traffic?.snapshot?.rules).toHaveLength(initial.rules.length);
    expect(traffic?.authoritativeSnapshot?.activeConnections).toHaveLength(1);
    expect(traffic?.pausedUpdateCount).toBe(1);

    act(() => traffic?.toggleViewPause());
    expect(traffic?.isViewPaused).toBe(false);
    expect(traffic?.snapshot).toEqual(traffic?.authoritativeSnapshot);
  });

  it("expires a paused capture at a profile or Traffic-session boundary", async () => {
    const client = new FixtureTrafficClient();
    const initial = await client.getSnapshot();
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot).not.toBeNull());

    act(() => traffic?.toggleViewPause());
    act(() => {
      client.publishSnapshot({
        ...initial,
        activeConnections: initial.activeConnections.slice(0, 1),
        profileId: "replacement-profile",
        sessionId: "replacement-session",
        sequence: 1,
      });
    });

    expect(traffic?.isViewPaused).toBe(false);
    expect(traffic?.snapshot?.profileId).toBe("replacement-profile");
    expect(traffic?.snapshot?.sessionId).toBe("replacement-session");
  });

  it("uses latest authority for a command initiated from a frozen connection", async () => {
    const client = new CommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot?.adapterKind).toBe("rpc"));

    act(() => traffic?.toggleViewPause());
    act(() => client.publishSnapshot({ ...initial, adapterKind: "rpc", sequence: 7 }));
    await act(async () => {
      await traffic?.closeConnection(initial.activeConnections[0]!.id);
    });

    expect(client.receivedAuthority).toMatchObject({ sequence: 7, sessionId: initial.sessionId });
    expect(traffic?.snapshot?.activeConnections).toHaveLength(initial.activeConnections.length);
    expect(traffic?.authoritativeSnapshot?.activeConnections).toHaveLength(
      initial.activeConnections.length - 1,
    );
  });

  it("does not let an older subscription snapshot restore a connection closed while paused", async () => {
    const client = new CommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot?.adapterKind).toBe("rpc"));

    act(() => traffic?.toggleViewPause());
    act(() => client.publishSnapshot({ ...initial, adapterKind: "rpc", sequence: 7 }));
    await act(async () => {
      await traffic?.closeConnection(initial.activeConnections[0]!.id);
    });
    act(() => client.publishSnapshot({ ...initial, adapterKind: "rpc", sequence: 7 }));
    act(() => traffic?.toggleViewPause());

    expect(traffic?.snapshot?.activeConnections.map(({ id }) => id)).not.toContain(
      initial.activeConnections[0]!.id,
    );
  });
});
