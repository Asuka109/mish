import { DiagnosticHistorySchema } from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { FixtureDiagnosticsClient } from "./fixture-diagnostics-client";

describe("FixtureDiagnosticsClient", () => {
  it("creates only explicit fictional runs and bounds local history", async () => {
    const client = new FixtureDiagnosticsClient();
    expect((await client.getHistory()).runs).toEqual([]);

    for (let index = 0; index < 10; index += 1) await client.startRun();
    const history = DiagnosticHistorySchema.parse(await client.getHistory());
    expect(history.adapterKind).toBe("fixture");
    expect(history.runs).toHaveLength(8);
    expect(history.runs[0].checks[0].interpretation).toContain("fictional");
    expect(history.runs[0].checks[0].interpretation).toContain("no desktop bridge");
  });
});
