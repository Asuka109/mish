import {
  ProfileClientError,
  type ProfileClient,
  type ProfileConnectionState,
  type ProfilePatchAuthorityDto,
  type ProfilePatchDto,
  type ProfilePatchEditorDto,
  type ProfilePreviewDto,
  type ProfileRefreshPolicy,
  type ProfileRouteCatalogDto,
  type ProfileSnapshotDto,
  type ProviderAuthorityDto,
  type ProviderKind,
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
    patches: "fixture-only",
    refresh: "fixture-only",
    scheduling: "fixture-only",
    save: "fixture-only",
  },
  profiles: [
    {
      effectiveFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      fileName: "studio-route-set.yaml",
      id: "fixture-profile-studio",
      label: "Studio route set",
      lastAttempt: { attemptedAt: 1_721_296_000_000, outcome: "succeeded" },
      lastKnownValid: true,
      lastSuccessAt: 1_721_296_000_000,
      refresh: {
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: 1_721_296_000_000,
        nextRunAt: 1_721_339_200_000,
        policy: "twelve-hours",
      },
      source: {
        display: "https://profiles.example/subscriptions/studio-route-set.yaml",
        sourceType: "https",
      },
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
        layers: [
          "source",
          "user-patches",
          "application-policy",
          "platform-integration",
          "effective-runtime",
        ],
        sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        unknownKeyCount: 0,
      },
      warningCodes: ["source-formatting-not-round-tripped"],
    },
    {
      effectiveFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      fileName: "home.yaml",
      id: "fixture-profile-home",
      label: "home.yaml",
      lastAttempt: { attemptedAt: 1_721_292_400_000, outcome: "succeeded" },
      lastKnownValid: true,
      lastSuccessAt: 1_721_292_400_000,
      refresh: {
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
        nextRunAt: null,
        policy: "off",
      },
      source: { display: "home.yaml", sourceType: "local-file" },
      status: {
        active: false,
        error: false,
        stale: false,
        updating: false,
        valid: true,
        warning: false,
      },
      runtimeProvenance: {
        artifactFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        authority: "illustrative-browser-fixture",
        items: [],
        layers: [
          "source",
          "user-patches",
          "application-policy",
          "platform-integration",
          "effective-runtime",
        ],
        sourceRevision: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        unknownKeyCount: 0,
      },
      warningCodes: [],
    },
  ],
  providers: {
    authority: null,
    capability: "fixture-only",
    observationFailure: null,
    observedAt: null,
    providers: [],
    remotelyCancellable: false,
  },
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

  async getPatches(
    authority: ProfilePatchAuthorityDto,
    options?: { signal?: AbortSignal },
  ): Promise<ProfilePatchEditorDto> {
    if (options?.signal?.aborted) throw cancelled();
    if (authority.profileId !== "fixture-profile-studio") throw unsupported();
    return structuredClone(fixturePatchEditor);
  }

  async getRoutes(
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileRouteCatalogDto> {
    if (options?.signal?.aborted) throw cancelled();
    if (profileId !== "fixture-profile-studio") throw unsupported();
    return structuredClone(fixtureRouteCatalog);
  }

  async deleteProfile(
    _profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileSnapshotDto> {
    if (options?.signal?.aborted) throw cancelled();
    throw unsupported();
  }

  async detachSubscription(
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

  async replacePatches(
    _authority: ProfilePatchAuthorityDto,
    _patches: ProfilePatchDto[],
    options?: { signal?: AbortSignal },
  ): Promise<never> {
    if (options?.signal?.aborted) throw cancelled();
    throw unsupported();
  }

  async setRefreshPolicy(
    _profileId: string,
    _policy: ProfileRefreshPolicy,
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

  async updateAllProviders(
    _authority: ProviderAuthorityDto,
    _kind: ProviderKind,
    options?: { signal?: AbortSignal },
  ): Promise<never> {
    if (options?.signal?.aborted) throw cancelled();
    throw unsupported();
  }

  async updateProvider(
    _authority: ProviderAuthorityDto,
    _providerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<never> {
    if (options?.signal?.aborted) throw cancelled();
    throw unsupported();
  }

  subscribeConnection(listener: (state: ProfileConnectionState) => void) {
    listener(this.getConnectionState());
    return () => undefined;
  }

  subscribeSnapshots(_listener: (snapshot: ProfileSnapshotDto) => void) {
    return () => undefined;
  }
}

const fixturePatchEditor = {
  activationBlocked: false,
  authority: {
    artifactFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    profileId: "fixture-profile-studio",
    sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  catalog: {
    groups: [],
    outbounds: [
      {
        id: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        kind: "built-in",
        label: "DIRECT",
      },
    ],
    ruleProviders: [],
    rules: [],
  },
  effectiveFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  patches: [
    {
      activationImpact: "insert-rule",
      enabled: true,
      id: "11111111-1111-4111-8111-111111111111",
      operation: {
        kind: "rule-insert",
        position: "prefix",
        rule: {
          kind: "standard",
          noResolve: false,
          ruleType: "domain-suffix",
          targetId: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          value: "fictional.example",
        },
      },
      order: 0,
      status: "enabled",
      target: "Rules · prefix",
      validationCode: "valid",
      validationResult: "valid",
    },
  ],
  schemaVersion: 1,
} satisfies ProfilePatchEditorDto;

const fixtureRouteCatalog = {
  fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  groups: [],
  nodes: [],
  profileId: "fixture-profile-studio",
  routingMode: "rule",
} satisfies ProfileRouteCatalogDto;

function cancelled() {
  return new ProfileClientError("cancelled", "The fixture profile request was cancelled");
}

function unsupported() {
  return new ProfileClientError(
    "unsupported",
    "Profile mutations are unavailable in isolated demo mode",
  );
}

export function createFixtureProfileClient() {
  return new FixtureProfileClient();
}
