import {
  LocalBackupPreviewSchema,
  LocalBackupScopeSchema,
  LocalRestorePreviewSchema,
  LocalRestoreResultSchema,
  StatusClientError,
  SupportBundleSaveResultSchema,
  type LocalBackupClient,
  type LocalBackupScopeDto,
  type LocalRestoreConflictResolution,
} from "@mish/contracts";

interface DesktopLocalBackupDependencies {
  invokeCommitRestore(
    previewId: string,
    resolution: LocalRestoreConflictResolution,
  ): Promise<unknown>;
  invokePreviewExport(scope: LocalBackupScopeDto): Promise<unknown>;
  invokePreviewRestore(): Promise<unknown>;
  invokeSaveExport(previewId: string): Promise<unknown>;
}

export class DesktopLocalBackupClient implements LocalBackupClient {
  readonly availability = "supported" as const;

  constructor(private readonly dependencies: DesktopLocalBackupDependencies) {}

  async previewExport(scope: LocalBackupScopeDto, options?: { signal?: AbortSignal }) {
    throwIfAborted(options?.signal);
    const validatedScope = LocalBackupScopeSchema.parse(scope);
    const preview = LocalBackupPreviewSchema.parse(
      await this.dependencies.invokePreviewExport(validatedScope),
    );
    throwIfAborted(options?.signal);
    return preview;
  }

  async saveExport(previewId: string, options?: { signal?: AbortSignal }) {
    throwIfAborted(options?.signal);
    validatePreviewId(previewId);
    const result = SupportBundleSaveResultSchema.parse(
      await this.dependencies.invokeSaveExport(previewId),
    );
    throwIfAborted(options?.signal);
    return result;
  }

  async previewRestore(options?: { signal?: AbortSignal }) {
    throwIfAborted(options?.signal);
    const value = await this.dependencies.invokePreviewRestore();
    throwIfAborted(options?.signal);
    return value === null ? null : LocalRestorePreviewSchema.parse(value);
  }

  async commitRestore(
    previewId: string,
    resolution: LocalRestoreConflictResolution,
    options?: { signal?: AbortSignal },
  ) {
    throwIfAborted(options?.signal);
    validatePreviewId(previewId);
    const result = LocalRestoreResultSchema.parse(
      await this.dependencies.invokeCommitRestore(previewId, resolution),
    );
    throwIfAborted(options?.signal);
    return result;
  }
}

export class UnavailableLocalBackupClient implements LocalBackupClient {
  readonly availability = "unavailable" as const;

  previewExport(_scope: LocalBackupScopeDto, _options?: { signal?: AbortSignal }): Promise<never> {
    return Promise.reject(unavailableError());
  }

  saveExport(_previewId: string, _options?: { signal?: AbortSignal }): Promise<never> {
    return Promise.reject(unavailableError());
  }

  previewRestore(_options?: { signal?: AbortSignal }): Promise<never> {
    return Promise.reject(unavailableError());
  }

  commitRestore(
    _previewId: string,
    _resolution: LocalRestoreConflictResolution,
    _options?: { signal?: AbortSignal },
  ): Promise<never> {
    return Promise.reject(unavailableError());
  }
}

function validatePreviewId(previewId: string) {
  if (!previewId || previewId.length > 128) {
    throw new StatusClientError("validation", "Invalid local backup preview ID");
  }
}

function unavailableError() {
  return new StatusClientError(
    "unsupported",
    "Local backup and restore are unavailable outside the desktop application",
  );
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new StatusClientError("cancelled", "Local backup action cancelled");
}
