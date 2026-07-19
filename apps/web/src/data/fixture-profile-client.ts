import {
  ProfileClientError,
  type ProfileClient,
  type ProfileConnectionState,
  type ProfilePreviewDto,
  type ProfileSnapshotDto,
} from "@mish/contracts";

const fixtureSnapshot = {
  activation: {
    activeFingerprint: null,
    activeProfileId: null,
    attemptedAt: null,
    availability: "unavailable",
    commandId: null,
    failure: null,
    operation: null,
    phase: "idle",
    safeStopped: true,
    startupPolicy: "safe-stopped",
    targetProfileId: null,
  },
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
      runtimeProvenance: {
        artifactFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        authority: "illustrative-browser-fixture",
        items: [
          {
            activationImpact: "preserved-in-effective-runtime",
            disposition: "preserved",
            fieldIdentity: "rules",
            owner: "source",
            reason: "portable-source-policy",
            sourcePresent: true,
          },
          {
            activationImpact: "replaced-by-application-value",
            disposition: "application-overridden",
            fieldIdentity: "mixed-port",
            owner: "application-policy",
            reason: "managed-proxy-ingress",
            sourcePresent: true,
          },
          {
            activationImpact: "forced-off",
            disposition: "disabled",
            fieldIdentity: "tun.enable",
            owner: "platform-integration",
            reason: "capture-requires-explicit-permission",
            sourcePresent: true,
          },
        ],
        layers: ["source", "application-policy", "platform-integration", "effective-runtime"],
        sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        unknownKeyCount: 0,
      },
      warningCodes: ["source-formatting-not-round-tripped"],
    },
  ],
} satisfies ProfileSnapshotDto;

export class FixtureProfileClient implements ProfileClient {
  activateProfile(
    _commandId: string,
    _profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<never> {
    if (options?.signal?.aborted) return Promise.reject(cancelled());
    return Promise.reject(unsupported());
  }

  cancelActivation(_commandId: string, options?: { signal?: AbortSignal }): Promise<never> {
    if (options?.signal?.aborted) return Promise.reject(cancelled());
    return Promise.reject(unsupported());
  }

  dispose() {}

  getConnectionState() {
    return { attempt: 0, phase: "fixture", stale: false } as const;
  }

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

  stopActiveProfile(_commandId: string, options?: { signal?: AbortSignal }): Promise<never> {
    if (options?.signal?.aborted) return Promise.reject(cancelled());
    return Promise.reject(unsupported());
  }

  subscribeConnection(listener: (state: ProfileConnectionState) => void) {
    listener(this.getConnectionState());
    return () => undefined;
  }

  subscribeSnapshots(_listener: (snapshot: ProfileSnapshotDto) => void) {
    return () => undefined;
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
