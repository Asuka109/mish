import {
  ProfileClientError,
  ProfilePreviewSchema,
  mishRpcMethods,
  type ProfileClient,
} from "@mish/contracts";
import {
  RpcCancelledError,
  RpcClient,
  RpcDisconnectedError,
  RpcDisposedError,
  RpcMessageTooLargeError,
  RpcProtocolError,
  RpcRemoteError,
  RpcValidationError,
  type RpcRequestOptions,
} from "@mish/rpc-client";

export type MishRpcClient = RpcClient<typeof mishRpcMethods>;
export type LocalProfilePreflight = (label?: string) => Promise<unknown>;

export class RpcProfileClient implements ProfileClient {
  constructor(
    private readonly rpc: MishRpcClient,
    private readonly localPreflight: LocalProfilePreflight,
  ) {}

  deleteProfile(profileId: string, options?: RpcRequestOptions) {
    return this.request("profiles.delete", { profileId }, options);
  }

  getSnapshot(options?: RpcRequestOptions) {
    return this.request("profiles.getSnapshot", {}, options);
  }

  preflightHttps(url: string, label?: string, options?: RpcRequestOptions) {
    return this.request("profiles.preflightHttps", { label, url }, options);
  }

  async preflightLocal(label?: string) {
    try {
      return ProfilePreviewSchema.nullable().parse(await this.localPreflight(label));
    } catch (error) {
      if (error instanceof ProfileClientError) throw error;
      throw new ProfileClientError("validation", "Local profile preflight failed");
    }
  }

  refreshProfile(profileId: string, options?: RpcRequestOptions) {
    return this.request("profiles.refresh", { profileId }, options);
  }

  savePreview(previewId: string, options?: RpcRequestOptions) {
    return this.request("profiles.save", { previewId }, options);
  }

  private async request<Method extends keyof typeof mishRpcMethods>(
    method: Method,
    params: Parameters<MishRpcClient["request"]>[1],
    options?: RpcRequestOptions,
  ) {
    try {
      return await this.rpc.request(method, params as never, options);
    } catch (error) {
      throw mapRpcError(error);
    }
  }
}

function mapRpcError(error: unknown) {
  if (error instanceof RpcCancelledError) {
    return new ProfileClientError("cancelled", error.message);
  }
  if (error instanceof RpcDisconnectedError || error instanceof RpcDisposedError) {
    return new ProfileClientError("disconnected", error.message, true);
  }
  if (error instanceof RpcValidationError) {
    return new ProfileClientError("validation", "Profile response validation failed");
  }
  if (error instanceof RpcMessageTooLargeError || error instanceof RpcProtocolError) {
    return new ProfileClientError("protocol", error.message);
  }
  if (error instanceof RpcRemoteError) {
    if (error.code === -32_602) return new ProfileClientError("invalid-request", error.message);
    if (error.code === -32_004) return new ProfileClientError("not-found", error.message);
    if (error.code === -32_009) return new ProfileClientError("conflict", error.message);
    return new ProfileClientError("remote", error.message, error.code === -32_040);
  }
  return new ProfileClientError("unknown", "Unknown profile client failure");
}
