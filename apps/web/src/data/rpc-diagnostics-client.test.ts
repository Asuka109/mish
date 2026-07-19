import { describe, expect, it, vi } from "vitest";
import type { DiagnosticsRpcClient } from "./rpc-diagnostics-client";
import { RpcDiagnosticsClient } from "./rpc-diagnostics-client";

describe("RpcDiagnosticsClient", () => {
  it("exposes only fixed-parameter history, start, and run-id cancellation calls", async () => {
    const history = { activeRunId: null, adapterKind: "rpc" as const, runs: [] };
    const request = vi.fn().mockResolvedValue(history);
    const client = new RpcDiagnosticsClient({ request } as unknown as DiagnosticsRpcClient);

    await client.getHistory();
    await client.startRun();
    await client.cancelRun("diagnostic-run-1");

    expect(request.mock.calls).toEqual([
      ["diagnostics.getHistory", {}, undefined],
      ["diagnostics.startRun", {}, undefined],
      ["diagnostics.cancelRun", { runId: "diagnostic-run-1" }, undefined],
    ]);
  });
});
