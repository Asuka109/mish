import { describe, expect, it } from "vitest";
import { FixtureStatusClient } from "./fixture-status-client";

describe("FixtureStatusClient", () => {
  it("returns detached typed snapshots", async () => {
    const client = new FixtureStatusClient();
    const first = await client.getSnapshot();
    first.profiles[0].label = "Changed outside the adapter";

    const second = await client.getSnapshot();
    expect(second.profiles[0].label).toBe("Home");
    expect(second.adapterKind).toBe("fixture");
  });

  it("keeps group selections scoped to group membership", async () => {
    const client = new FixtureStatusClient();
    await expect(client.selectGroupChild("streaming", "hkg-01")).rejects.toThrow(
      "does not belong to this group",
    );

    const next = await client.selectGroupChild("streaming", "nrt-03");
    expect(next.groups.find((group) => group.id === "streaming")?.selectedChildId).toBe("nrt-03");
    expect(next.groups.find((group) => group.id === "proxy")?.selectedChildId).toBe("hkg-02");
  });

  it("models capture actions as fixture state only", async () => {
    const client = new FixtureStatusClient();
    const stopped = await client.setCapture(false, false);
    expect(stopped.runtime.phase).toBe("inactive");
    expect(stopped.capabilities.systemProxy).toBe("fixture-only");

    const started = await client.setCapture(true, false);
    expect(started.runtime).toMatchObject({
      phase: "healthy",
      systemProxyEnabled: true,
      tunEnabled: false,
    });
  });
});
