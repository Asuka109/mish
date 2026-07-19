import {
  StatusClientError,
  SupportBundlePreviewSchema,
  SupportBundleSaveResultSchema,
  type SupportBundleClient,
} from "@mish/contracts";

interface DesktopSupportBundleDependencies {
  invokePreview(): Promise<unknown>;
  invokeSave(previewId: string): Promise<unknown>;
}

export class DesktopSupportBundleClient implements SupportBundleClient {
  readonly availability = "supported" as const;

  constructor(private readonly dependencies: DesktopSupportBundleDependencies) {}

  async preview(options?: { signal?: AbortSignal }) {
    throwIfAborted(options?.signal);
    const preview = SupportBundlePreviewSchema.parse(await this.dependencies.invokePreview());
    throwIfAborted(options?.signal);
    return preview;
  }

  async save(previewId: string, options?: { signal?: AbortSignal }) {
    throwIfAborted(options?.signal);
    if (!previewId || previewId.length > 128) {
      throw new StatusClientError("validation", "Invalid support bundle preview ID");
    }
    const result = SupportBundleSaveResultSchema.parse(
      await this.dependencies.invokeSave(previewId),
    );
    throwIfAborted(options?.signal);
    return result;
  }
}

export class UnavailableSupportBundleClient implements SupportBundleClient {
  readonly availability = "unavailable" as const;

  preview(_options?: { signal?: AbortSignal }): Promise<never> {
    return Promise.reject(
      new StatusClientError(
        "unsupported",
        "Support bundle export is unavailable outside the desktop application",
      ),
    );
  }

  save(_previewId: string, _options?: { signal?: AbortSignal }): Promise<never> {
    return Promise.reject(
      new StatusClientError(
        "unsupported",
        "Support bundle export is unavailable outside the desktop application",
      ),
    );
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new StatusClientError("cancelled", "Support bundle action cancelled");
}
