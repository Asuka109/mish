import {
  ProfileClientError,
  type ProfileClient,
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

export type ProfileOperation = "delete" | "preflight" | "refresh" | "save";
export type ProfileOperationResult = { ok: true } | { error: ProfileClientError; ok: false };
export type ProfilePreviewResult =
  | { ok: true; preview: ProfilePreviewDto | null }
  | { error: ProfileClientError; ok: false };

interface ProfileContextValue {
  deleteProfile(profileId: string): Promise<ProfileOperationResult>;
  error: ProfileClientError | null;
  isLoading: boolean;
  isPending(operation: ProfileOperation, profileId?: string): boolean;
  preflightHttps(url: string, label?: string): Promise<ProfilePreviewResult>;
  preflightLocal(label?: string): Promise<ProfilePreviewResult>;
  refreshProfile(profileId: string): Promise<ProfileOperationResult>;
  savePreview(previewId: string): Promise<ProfileOperationResult>;
  snapshot: ProfileSnapshotDto | null;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

interface ProfileProviderProps {
  children: ReactNode;
  client?: ProfileClient;
}

export function ProfileProvider({ children, client }: ProfileProviderProps) {
  const resolvedClient = useMemo(() => client ?? createFixtureProfileClient(), [client]);
  const [snapshot, setSnapshot] = useState<ProfileSnapshotDto | null>(null);
  const [error, setError] = useState<ProfileClientError | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
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
    return () => controller.abort();
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

  const value = useMemo<ProfileContextValue>(
    () => ({
      deleteProfile: (profileId) =>
        runMutation("delete", profileId, () => resolvedClient.deleteProfile(profileId)),
      error,
      isLoading: snapshot === null && error === null,
      isPending: (operation, profileId) => pendingKey === operationKey(operation, profileId),
      preflightHttps: (url, label) => runPreflight(() => resolvedClient.preflightHttps(url, label)),
      preflightLocal: (label) => runPreflight(() => resolvedClient.preflightLocal(label)),
      refreshProfile: (profileId) =>
        runMutation("refresh", profileId, () => resolvedClient.refreshProfile(profileId)),
      savePreview: (previewId) =>
        runMutation("save", undefined, () => resolvedClient.savePreview(previewId)),
      snapshot,
    }),
    [error, pendingKey, resolvedClient, runMutation, runPreflight, snapshot],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfiles() {
  const context = useContext(ProfileContext);
  if (!context) throw new Error("useProfiles must be used inside ProfileProvider");
  return context;
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
