import { mishRpcMethods, type DiagnosticHistoryDto, type DiagnosticsClient } from "@mish/contracts";
import type { RpcClient, RpcRequestOptions } from "@mish/rpc-client";

export type DiagnosticsRpcClient = RpcClient<typeof mishRpcMethods>;

export class RpcDiagnosticsClient implements DiagnosticsClient {
  constructor(private readonly rpc: DiagnosticsRpcClient) {}

  cancelRun(runId: string, options?: RpcRequestOptions): Promise<DiagnosticHistoryDto> {
    return this.rpc.request("diagnostics.cancelRun", { runId }, options);
  }

  dispose() {}

  getHistory(options?: RpcRequestOptions): Promise<DiagnosticHistoryDto> {
    return this.rpc.request("diagnostics.getHistory", {}, options);
  }

  startRun(options?: RpcRequestOptions): Promise<DiagnosticHistoryDto> {
    return this.rpc.request("diagnostics.startRun", {}, options);
  }
}
