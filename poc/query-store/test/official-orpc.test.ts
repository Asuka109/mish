import { describe, expect, it } from "vitest";

import { createOrpcMutation, createOrpcQueryOptions, createQueryClient } from "../src/index.ts";
import { createStatusFixture } from "./orpc-fixture.ts";

describe("official oRPC TanStack Query adapter", () => {
  it("builds contract-first query and mutation options through the locked package", async () => {
    const paths: Array<readonly string[]> = [];
    const fixture = createStatusFixture(async (input, path) => {
      paths.push(path);
      return { id: input.id, revision: 1 };
    });
    const client = createQueryClient();
    const queryOptions = createOrpcQueryOptions(fixture.utils, {
      input: { id: "profile-a" },
      staleTime: 10_000,
      retry: 1,
      retryDelay: 0,
    });
    const mutationOptions = fixture.utils.mutationOptions({
      retry: 1,
      retryDelay: 0,
    });

    expect(queryOptions.queryKey).toEqual([
      ["status"],
      { type: "query", input: { id: "profile-a" } },
    ]);
    expect(queryOptions.staleTime).toBe(10_000);
    expect(queryOptions.retry).toBe(1);
    expect(mutationOptions.mutationKey).toEqual([["status"], { type: "mutation" }]);
    expect(mutationOptions.retry).toBe(1);

    await expect(client.fetchQuery(queryOptions)).resolves.toEqual({
      id: "profile-a",
      revision: 1,
    });

    const mutation = createOrpcMutation(client, fixture.utils, {
      retry: 1,
      retryDelay: 0,
    });
    await expect(mutation.execute({ id: "profile-b" })).resolves.toEqual({
      id: "profile-b",
      revision: 1,
    });
    expect(mutation.getState().status).toBe("success");
    expect(paths).toEqual([["status"], ["status"]]);
    client.clear();
  });
});
