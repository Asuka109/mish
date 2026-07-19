import {
  ProfileClientError,
  type ProfileActivationSnapshotDto,
  type ProfileClient,
  type ProfileConnectionState,
  type ProfileRefreshPolicy,
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
  | "delete"
  | "preflight"
  | "provider-update"
  | "refresh"
  | "schedule"
  | "save"
  | "stop";
export type ProfileOperationResult = { ok: true } | { error: ProfileClientError; ok: false };
export type ProfilePreviewResult =
  | { ok: true; preview: ProfilePreviewDto | null }
  | { error: ProfileClientError; ok: false };

interface ProfileContextValue {
  activateProfile(profileId: string): Promise<ProfileOperationResult>;
  cancelActivation(): Promise<ProfileOperationResult>;
  connection: ProfileConnectionState;
  deleteProfile(profileId: string): Promise<ProfileOperationResult>;
  error: ProfileClientError | null;
  isLoading: boolean;
  isPending(operation: ProfileOperation, profileId?: string): boolean;
  preflightHttps(url: string, label?: string): Promise<ProfilePreviewResult>;
  preflightLocal(label?: string): Promise<ProfilePreviewResult>;
  refreshProfile(profileId: string): Promise<ProfileOperationResult>;
  setRefreshPolicy(
    profileId: string,
    policy: ProfileRefreshPolicy,
  ): Promise<ProfileOperationResult>;
  savePreview(previewId: string): Promise<ProfileOperationResult>;
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
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

interface ProfileProviderProps {
  children: ReactNode;
  client?: ProfileClient;
}

export function ProfileProvider({ children, client }: ProfileProviderProps) {
  const resolvedClient = useMemo(() => client ?? createFixtureProfileClient(), [client]);
  const [snapshot, setSnapshot] = useState<ProfileSnapshotDto | null>(null);
  const [connection, setConnection] = useState<ProfileConnectionState>(() =>
    resolvedClient.getConnectionState(),
  );
  const [error, setError] = useState<ProfileClientError | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const unsubscribeConnection = resolvedClient.subscribeConnection(setConnection);
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setError(null);
    });
    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setError(null);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setError(toProfileClientError(failure));
      });
    return () => {
      controller.abort();
      unsubscribeConnection();
      unsubscribeSnapshots();
    };
  }, [resolvedClient]);

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
        setSnapshot(await mutate());
        return { ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        setError(typedError);
        if (operation === "refresh") {
          try {
            setSnapshot(await resolvedClient.getSnapshot());
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
    [resolvedClient],
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
        setSnapshot((current) => (current ? { ...current, activation } : current));
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
    [snapshot?.activation.phase],
  );

  const value = useMemo<ProfileContextValue>(
    () => ({
      activateProfile: (profileId) =>
        runActivation("activate", () =>
          resolvedClient.activateProfile(crypto.randomUUID(), profileId),
        ),
      cancelActivation: () => {
        const commandId = snapshot?.activation.commandId;
        if (!commandId) return Promise.resolve(conflict());
        return runActivation("activate", () => resolvedClient.cancelActivation(commandId), true);
      },
      connection,
      deleteProfile: (profileId) =>
        runMutation("delete", profileId, () => resolvedClient.deleteProfile(profileId)),
      error,
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
      preflightHttps: (url, label) => runPreflight(() => resolvedClient.preflightHttps(url, label)),
      preflightLocal: (label) => runPreflight(() => resolvedClient.preflightLocal(label)),
      refreshProfile: (profileId) =>
        runMutation("refresh", profileId, () => resolvedClient.refreshProfile(profileId)),
      setRefreshPolicy: (profileId, policy) =>
        runMutation("schedule", profileId, () =>
          resolvedClient.setRefreshPolicy(profileId, policy),
        ),
      savePreview: (previewId) =>
        runMutation("save", undefined, () => resolvedClient.savePreview(previewId)),
      snapshot,
      stopActiveProfile: () =>
        runActivation("stop", () => resolvedClient.stopActiveProfile(crypto.randomUUID())),
      updateAllProviders: (authority, kind) =>
        runProviderMutation(kind, () => resolvedClient.updateAllProviders(authority, kind)),
      updateProvider: (authority, providerId) =>
        runProviderMutation(providerId, () => resolvedClient.updateProvider(authority, providerId)),
    }),
    [
      connection,
      error,
      pendingKey,
      resolvedClient,
      runActivation,
      runMutation,
      runPreflight,
      runProviderMutation,
      snapshot,
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

function toProfileClientError(error: unknown) {
  if (error instanceof ProfileClientError) return error;
  return new ProfileClientError("unknown", "Unknown profile operation failure");
}
