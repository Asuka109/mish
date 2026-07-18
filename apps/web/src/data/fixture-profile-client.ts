import {
  ProfileClientError,
  type ProfileClient,
  type ProfilePreviewDto,
  type ProfileSnapshotDto,
} from "@mish/contracts";

const fixtureSnapshot = {
  adapterKind: "fixture",
  capabilities: {
    activation: "unavailable",
    deletion: "fixture-only",
    httpsImport: "fixture-only",
    localFileImport: "fixture-only",
    refresh: "fixture-only",
    save: "fixture-only",
  },
  profiles: [
    {
      id: "fixture-profile-studio",
      label: "Studio route set",
      lastAttempt: { attemptedAt: 1_721_296_000_000, outcome: "succeeded" },
      lastKnownValid: true,
      lastSuccessAt: 1_721_296_000_000,
      source: { display: "https://profiles.example/…", sourceType: "https" },
      status: {
        active: false,
        error: false,
        stale: false,
        updating: false,
        valid: true,
        warning: true,
      },
      warningCodes: ["source-formatting-not-round-tripped"],
    },
  ],
} satisfies ProfileSnapshotDto;

export class FixtureProfileClient implements ProfileClient {
  async getSnapshot(options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) throw cancelled();
    return structuredClone(fixtureSnapshot);
  }

  async deleteProfile(
    _profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileSnapshotDto> {
    if (options?.signal?.aborted) throw cancelled();
    throw unsupported();
  }

  async preflightHttps(
    _url: string,
    _label?: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfilePreviewDto> {
    if (options?.signal?.aborted) throw cancelled();
    throw unsupported();
  }

  async preflightLocal(_label?: string): Promise<ProfilePreviewDto | null> {
    throw unsupported();
  }

  async refreshProfile(
    _profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileSnapshotDto> {
    if (options?.signal?.aborted) throw cancelled();
    throw unsupported();
  }

  async savePreview(
    _previewId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileSnapshotDto> {
    if (options?.signal?.aborted) throw cancelled();
    throw unsupported();
  }
}

function cancelled() {
  return new ProfileClientError("cancelled", "The fixture profile request was cancelled");
}

function unsupported() {
  return new ProfileClientError(
    "unsupported",
    "Profile mutations are unavailable in the isolated browser fixture",
  );
}

export function createFixtureProfileClient() {
  return new FixtureProfileClient();
}
