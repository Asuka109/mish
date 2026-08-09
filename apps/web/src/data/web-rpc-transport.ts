import { mishRpcMethods, type StatusConnectionState } from "@mish/contracts";
import {
  RpcCancelledError,
  RpcClient,
  RpcCompatibilityError,
  RpcDisconnectedError,
  RpcDisposedError,
  RpcMessageTooLargeError,
  RpcProtocolError,
  RpcValidationError,
  type RpcConnectionState,
} from "@mish/rpc-client";

export interface WebRpcTransport {
  dispose(): void;
  getConnectionState(): RpcConnectionState;
  onNotification: RpcClient<typeof mishRpcMethods>["onNotification"];
  request: RpcClient<typeof mishRpcMethods>["request"];
  subscribeConnection(listener: (state: RpcConnectionState) => void): () => void;
}

export interface RpcClientFailureProjection {
  code: "cancelled" | "disconnected" | "protocol" | "unknown" | "validation";
  message: string;
  retryable: boolean;
}

export function projectRpcConnectionState(state: RpcConnectionState): StatusConnectionState {
  if (
    state.phase === "authenticating" ||
    state.phase === "connecting" ||
    state.phase === "negotiating"
  ) {
    return { attempt: state.attempt, phase: "connecting", stale: true };
  }
  return { attempt: state.attempt, phase: state.phase, stale: state.stale };
}

export function projectRpcClientFailure(error: unknown): RpcClientFailureProjection {
  if (error instanceof RpcCancelledError) {
    return { code: "cancelled", message: error.message, retryable: false };
  }
  if (error instanceof RpcCompatibilityError) {
    return { code: "protocol", message: error.message, retryable: false };
  }
  if (error instanceof RpcDisconnectedError || error instanceof RpcDisposedError) {
    return { code: "disconnected", message: error.message, retryable: true };
  }
  if (error instanceof RpcValidationError) {
    return { code: "validation", message: error.message, retryable: false };
  }
  if (error instanceof RpcMessageTooLargeError || error instanceof RpcProtocolError) {
    return { code: "protocol", message: error.message, retryable: false };
  }
  if (error instanceof Error) {
    return { code: "unknown", message: error.message, retryable: false };
  }
  return { code: "unknown", message: "Unknown RPC client failure", retryable: false };
}
