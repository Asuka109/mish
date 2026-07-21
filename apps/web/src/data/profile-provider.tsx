import {
  ProfileClientError,
  type ProfileActivationSnapshotDto,
  type ProfileClient,
  type ProfileConnectionState,
  type ProfilePatchAuthorityDto,
  type ProfilePatchDto,
  type ProfilePatchEditorDto,
  type ProfileRefreshPolicy,
  type ProfileRouteCatalogDto,
  type ProviderAuthorityDto,
  type ProviderKind,
  type ProfilePreviewDto,
  type ProfileSnapshotDto,
} from "@mish/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createFixtureProfileClient } from "./fixture-profile-client";

export type ProfileOperation =
  | "activate"
  | "create"
  | "delete"
  | "detach"
  | "preflight"
  | "patch-save"
  | "provider-update"
  | "refresh"
  | "schedule"
  | "save"
  | "stop";
export type ProfileOperationResult = { ok: true } | { error: ProfileClientError; ok: false };
export type ProfilePreviewResult =
  | { ok: true; preview: ProfilePreviewDto | null }
  | { error: ProfileClientError; ok: false };
export type ProfilePatchEditorResult =
  | { editor: ProfilePatchEditorDto; ok: true }
  | { error: ProfileClientError; ok: false };
export type ProfileRouteCatalogResult =
  | { catalog: ProfileRouteCatalogDto; ok: true }
  | { error: ProfileClientError; ok: false };

interface ProfileContextValue {
  activateProfile(profileId: string): Promise<ProfileOperationResult>;
  cancelActivation(): Promise<ProfileOperationResult>;
  connection: ProfileConnectionState;
  createProfile(fileName: string): Promise<ProfileOperationResult>;
  createProfileAvailable: boolean;
  deleteProfile(profileId: string): Promise<ProfileOperationResult>;
  detachSubscription(profileId: string): Promise<ProfileOperationResult>;
  error: ProfileClientError | null;
  fileActionsAvailable: boolean;
  isLoading: boolean;
  isPending(operation: ProfileOperation, profileId?: string): boolean;
  loadPatches(authority: ProfilePatchAuthorityDto): Promise<ProfilePatchEditorResult>;
  loadRoutes(profileId: string): Promise<ProfileRouteCatalogResult>;
  openProfileDirectory(): Promise<ProfileOperationResult>;
  preflightHttps(url: string, label?: string): Promise<ProfilePreviewResult>;
  preflightLocal(label?: string): Promise<ProfilePreviewResult>;
  refreshProfile(profileId: string): Promise<ProfileOperationResult>;
  replacePatches(
    authority: ProfilePatchAuthorityDto,
    patches: ProfilePatchDto[],
  ): Promise<ProfilePatchEditorResult>;
  setRefreshPolicy(
    profileId: string,
    policy: ProfileRefreshPolicy,
  ): Promise<ProfileOperationResult>;
  savePreview(previewId: string): Promise<ProfileOperationResult>;
  selectedProfileId: string | null;
  selectProfile(profileId: string): void;
  snapshot: ProfileSnapshotDto | null;
  stopActiveProfile(): Promise<ProfileOperationResult>;
  updateAllProviders(
    authority: ProviderAuthorityDto,
    kind: ProviderKind,
  ): Promise<ProfileOperationResult>;
  updateProvider(
    authority: ProviderAuthorityDto,
    providerId: string,
  ): Promise<ProfileOperationResult>;
  waitForProfileActivation(profileId: string): Promise<ProfileOperationResult>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

interface ProfileProviderProps {
  children: ReactNode;
  client?: ProfileClient;
}

export function ProfileProvider({ children, client }: ProfileProviderProps) {
  const resolvedClient = useMemo<ProfileClient>(
    () => client ?? createFixtureProfileClient(),
    [client],
  );
  const [snapshot, setSnapshot] = useState<ProfileSnapshotDto | null>(null);
  const [connection, setConnection] = useState<ProfileConnectionState>(() =>
    resolvedClient.getConnectionState(),
  );
  const [error, setError] = useState<ProfileClientError | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(() =>
    readSelectedProfileId(),
  );
  const pending = useRef(false);
  const latestSnapshot = useRef<ProfileSnapshotDto | null>(null);
  const activationWaiters = useRef(
    new Map<
      string,
      {
        reject(error: ProfileClientError): void;
        resolve(activation: ProfileActivationSnapshotDto): void;
      }
    >(),
  );

  const acceptSnapshot = useCallback((nextSnapshot: ProfileSnapshotDto) => {
    latestSnapshot.current = nextSnapshot;
    setSnapshot(nextSnapshot);
    setError(null);
    setSelectedProfileId((current) => {
      const available = new Set(nextSnapshot.profiles.map((profile) => profile.id));
      const next =
        (current && available.has(current) ? current : null) ??
        (nextSnapshot.activation.targetProfileId &&
        available.has(nextSnapshot.activation.targetProfileId)
          ? nextSnapshot.activation.targetProfileId
          : null) ??
        (nextSnapshot.activation.activeProfileId &&
        available.has(nextSnapshot.activation.activeProfileId)
          ? nextSnapshot.activation.activeProfileId
          : null) ??
        nextSnapshot.profiles.find((profile) => profile.status.active)?.id ??
        nextSnapshot.profiles[0]?.id ??
        null;
      persistSelectedProfileId(next);
      return next;
    });
    const activation = nextSnapshot.activation;
    if (activation.phase === "pending" || !activation.commandId) return;
    const waiter = activationWaiters.current.get(activation.commandId);
    if (!waiter) return;
    activationWaiters.current.delete(activation.commandId);
    waiter.resolve(activation);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const unsubscribeConnection = resolvedClient.subscribeConnection(setConnection);
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots(acceptSnapshot);
    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then(acceptSnapshot)
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setError(toProfileClientError(failure));
      });
    return () => {
      controller.abort();
      unsubscribeConnection();
      unsubscribeSnapshots();
      for (const waiter of activationWaiters.current.values()) {
        waiter.reject(new ProfileClientError("cancelled", "Profile activation wait cancelled"));
      }
      activationWaiters.current.clear();
    };
  }, [acceptSnapshot, resolvedClient]);

  const runMutation = useCallback(
    async (
      operation: Exclude<ProfileOperation, "preflight">,
      profileId: string | undefined,
      mutate: () => Promise<ProfileSnapshotDto>,
    ): Promise<ProfileOperationResult> => {
      if (pending.current) return conflict();
      pending.current = true;
      setPendingKey(operationKey(operation, profileId));
      setError(null);
      try {
        acceptSnapshot(await mutate());
        return { ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        if (operation === "refresh") {
          try {
            acceptSnapshot(await resolvedClient.getSnapshot());
          } catch {
            // Keep the previous safe snapshot when reconciliation also fails.
          }
        }
        return { error: typedError, ok: false };
      } finally {
        pending.current = false;
        setPendingKey(null);
      }
    },
    [acceptSnapshot, resolvedClient],
  );

  const runPreflight = useCallback(
    async (preflight: () => Promise<ProfilePreviewDto | null>): Promise<ProfilePreviewResult> => {
      if (pending.current) return conflict();
      pending.current = true;
      setPendingKey(operationKey("preflight"));
      setError(null);
      try {
        return { ok: true, preview: await preflight() };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        return { error: typedError, ok: false };
      } finally {
        pending.current = false;
        setPendingKey(null);
      }
    },
    [],
  );

  const runProviderMutation = useCallback(
    async (
      providerId: string | undefined,
      mutate: () => ReturnType<ProfileClient["updateProvider"]>,
    ): Promise<ProfileOperationResult> => {
      if (pending.current) return conflict();
      pending.current = true;
      setPendingKey(operationKey("provider-update", providerId));
      setError(null);
      try {
        const result = await mutate();
        setSnapshot((current) => (current ? { ...current, providers: result.snapshot } : current));
        if (result.phase !== "success") {
          return {
            error: new ProfileClientError("remote", "Provider update failed", true),
            ok: false,
          };
        }
        return { ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        return { error: typedError, ok: false };
      } finally {
        pending.current = false;
        setPendingKey(null);
      }
    },
    [],
  );

  const loadPatches = useCallback(
    async (authority: ProfilePatchAuthorityDto): Promise<ProfilePatchEditorResult> => {
      try {
        return { editor: await resolvedClient.getPatches(authority), ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        return { error: typedError, ok: false };
      }
    },
    [resolvedClient],
  );

  const loadRoutes = useCallback(
    async (profileId: string): Promise<ProfileRouteCatalogResult> => {
      if (!resolvedClient.getRoutes) {
        return {
          error: new ProfileClientError(
            "unsupported",
            "Configured routes are unavailable in this profile client",
          ),
          ok: false,
        };
      }
      try {
        return { catalog: await resolvedClient.getRoutes(profileId), ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        return { error: typedError, ok: false };
      }
    },
    [resolvedClient],
  );

  const runFileAction = useCallback(
    async (action: (() => Promise<void>) | undefined): Promise<ProfileOperationResult> => {
      if (!action) {
        return {
          error: new ProfileClientError("unsupported", "Profile file actions are unavailable"),
          ok: false,
        };
      }
      try {
        await action();
        return { ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        return { error: typedError, ok: false };
      }
    },
    [],
  );

  const replacePatches = useCallback(
    async (
      authority: ProfilePatchAuthorityDto,
      patches: ProfilePatchDto[],
    ): Promise<ProfilePatchEditorResult> => {
      if (pending.current) return conflict();
      pending.current = true;
      setPendingKey(operationKey("patch-save", authority.profileId));
      setError(null);
      try {
        const editor = await resolvedClient.replacePatches(authority, patches);
        acceptSnapshot(await resolvedClient.getSnapshot());
        return { editor, ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        return { error: typedError, ok: false };
      } finally {
        pending.current = false;
        setPendingKey(null);
      }
    },
    [acceptSnapshot, resolvedClient],
  );

  const runActivation = useCallback(
    async (
      operation: "activate" | "stop",
      mutate: () => Promise<ProfileActivationSnapshotDto>,
      allowPending = false,
    ): Promise<ProfileOperationResult> => {
      if (pending.current || (!allowPending && snapshot?.activation.phase === "pending")) {
        return conflict();
      }
      pending.current = true;
      setPendingKey(operationKey(operation));
      setError(null);
      try {
        const activation = await mutate();
        const current = latestSnapshot.current;
        const alreadyCompleted =
          current?.activation.commandId === activation.commandId &&
          current.activation.phase !== "pending";
        if (current && !alreadyCompleted) acceptSnapshot({ ...current, activation });
        return { ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        return { error: typedError, ok: false };
      } finally {
        pending.current = false;
        setPendingKey(null);
      }
    },
    [acceptSnapshot, snapshot?.activation.phase],
  );

  const waitForProfileActivation = useCallback(
    async (profileId: string): Promise<ProfileOperationResult> => {
      const activation = latestSnapshot.current?.activation;
      if (!activation || activation.targetProfileId !== profileId) return conflict();
      if (activation.phase !== "pending") {
        return activation.phase === "success"
          ? { ok: true }
          : activationFailure(activation.failure);
      }
      if (!activation.commandId) return conflict();
      try {
        const completed = await new Promise<ProfileActivationSnapshotDto>((resolve, reject) => {
          activationWaiters.current.set(activation.commandId!, { reject, resolve });
        });
        return completed.phase === "success" ? { ok: true } : activationFailure(completed.failure);
      } catch (failure) {
        return { error: toProfileClientError(failure), ok: false };
      }
    },
    [],
  );

  const selectProfile = useCallback((profileId: string) => {
    if (!latestSnapshot.current?.profiles.some((profile) => profile.id === profileId)) return;
    persistSelectedProfileId(profileId);
    setSelectedProfileId(profileId);
  }, []);

  const value = useMemo<ProfileContextValue>(
    () => ({
      activateProfile: (profileId) => {
        selectProfile(profileId);
        return runActivation("activate", () =>
          resolvedClient.activateProfile(crypto.randomUUID(), profileId),
        );
      },
      cancelActivation: () => {
        const commandId = snapshot?.activation.commandId;
        if (!commandId) return Promise.resolve(conflict());
        return runActivation("activate", () => resolvedClient.cancelActivation(commandId), true);
      },
      connection,
      createProfile: (fileName) =>
        resolvedClient.createProfile
          ? runMutation("create", undefined, () => resolvedClient.createProfile!(fileName))
          : Promise.resolve({
              error: new ProfileClientError("unsupported", "Profile creation is unavailable"),
              ok: false as const,
            }),
      createProfileAvailable: Boolean(resolvedClient.createProfile),
      deleteProfile: (profileId) =>
        runMutation("delete", profileId, () => resolvedClient.deleteProfile(profileId)),
      detachSubscription: (profileId) =>
        resolvedClient.detachSubscription
          ? runMutation("detach", profileId, () => resolvedClient.detachSubscription!(profileId))
          : Promise.resolve({
              error: new ProfileClientError(
                "unsupported",
                "Subscription detachment is unavailable",
              ),
              ok: false as const,
            }),
      error,
      fileActionsAvailable: Boolean(resolvedClient.openProfileDirectory),
      isLoading: snapshot === null && error === null,
      isPending: (operation, profileId) => {
        if (
          snapshot?.activation.phase === "pending" &&
          snapshot.activation.operation === operation
        ) {
          return !profileId || snapshot.activation.targetProfileId === profileId;
        }
        return pendingKey === operationKey(operation, profileId);
      },
      loadPatches,
      loadRoutes,
      openProfileDirectory: () =>
        runFileAction(
          resolvedClient.openProfileDirectory
            ? () => resolvedClient.openProfileDirectory!()
            : undefined,
        ),
      preflightHttps: (url, label) => runPreflight(() => resolvedClient.preflightHttps(url, label)),
      preflightLocal: (label) => runPreflight(() => resolvedClient.preflightLocal(label)),
      refreshProfile: (profileId) =>
        runMutation("refresh", profileId, () => resolvedClient.refreshProfile(profileId)),
      replacePatches,
      setRefreshPolicy: (profileId, policy) =>
        runMutation("schedule", profileId, () =>
          resolvedClient.setRefreshPolicy(profileId, policy),
        ),
      savePreview: (previewId) =>
        runMutation("save", undefined, () => resolvedClient.savePreview(previewId)),
      selectedProfileId,
      selectProfile,
      snapshot,
      stopActiveProfile: () =>
        runActivation("stop", () => resolvedClient.stopActiveProfile(crypto.randomUUID())),
      updateAllProviders: (authority, kind) =>
        runProviderMutation(kind, () => resolvedClient.updateAllProviders(authority, kind)),
      updateProvider: (authority, providerId) =>
        runProviderMutation(providerId, () => resolvedClient.updateProvider(authority, providerId)),
      waitForProfileActivation,
    }),
    [
      connection,
      error,
      pendingKey,
      resolvedClient,
      runActivation,
      runMutation,
      loadPatches,
      loadRoutes,
      replacePatches,
      runPreflight,
      runProviderMutation,
      runFileAction,
      selectedProfileId,
      selectProfile,
      snapshot,
      waitForProfileActivation,
    ],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfiles() {
  const context = useContext(ProfileContext);
  if (!context) throw new Error("useProfiles must be used inside ProfileProvider");
  return context;
}

export function useOptionalProfiles() {
  return useContext(ProfileContext);
}

function operationKey(operation: ProfileOperation, profileId?: string) {
  return profileId ? `${operation}:${profileId}` : operation;
}

function conflict() {
  return {
    error: new ProfileClientError("conflict", "Another profile operation is already pending", true),
    ok: false,
  } as const;
}

function activationFailure(failure: ProfileActivationSnapshotDto["failure"]) {
  return {
    error: new ProfileClientError("remote", `Profile activation failed: ${failure ?? "unknown"}`),
    ok: false,
  } as const;
}

function toProfileClientError(error: unknown) {
  if (error instanceof ProfileClientError) return error;
  return new ProfileClientError("unknown", "Unknown profile operation failure");
}

const selectedProfileStorageKey = "mish.selected-profile-id";

function readSelectedProfileId() {
  try {
    return window.localStorage.getItem(selectedProfileStorageKey);
  } catch {
    return null;
  }
}

function persistSelectedProfileId(profileId: string | null) {
  try {
    if (profileId) window.localStorage.setItem(selectedProfileStorageKey, profileId);
    else window.localStorage.removeItem(selectedProfileStorageKey);
  } catch {
    // Selection remains available for the current session when storage is unavailable.
  }
}
