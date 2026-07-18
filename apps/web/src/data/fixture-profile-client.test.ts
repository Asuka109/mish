import { describe, expect, it } from "vitest";
import { ProfileClientError } from "@mish/contracts";
import { FixtureProfileClient } from "./fixture-profile-client";

describe("FixtureProfileClient", () => {
  it("returns detached fictional metadata", async () => {
    const client = new FixtureProfileClient();
    const first = await client.getSnapshot();
    first.profiles[0].label = "mutated";
    const second = await client.getSnapshot();

    expect(second.adapterKind).toBe("fixture");
    expect(second.profiles[0].label).toBe("Studio route set");
  });

  it("rejects local file preflight instead of reporting fixture success", async () => {
    const client = new FixtureProfileClient();
    await expect(client.preflightLocal()).rejects.toEqual(
      expect.objectContaining<Partial<ProfileClientError>>({ code: "unsupported" }),
    );
  });
});
