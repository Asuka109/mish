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
  type ProfileSelectionSnapshotDto,
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
import {
  ApplicationSnapshotAcceptance,
  type SnapshotDelivery,
} from "./application-snapshot-acceptance";
import {
  applicationCommandAuthority,
  applicationCommandScope,
  useCommandFeedback,
  type CommandFeedbackOperation,
} from "./command-feedback";
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
  | "select"
  | "save"
  | "stop";
export type ProfileOperationResult = { ok: true } | { error: ProfileClientError; ok: false };
export type ProfileSelectionOperationResult =
  | { ok: true; selection: ProfileSelectionSnapshotDto }
  | { error: ProfileClientError; ok: false };
export type ProfilePreviewResult =
  | { ok: true; preview: ProfilePreviewDto | null }
  | { error: ProfileClientError; ok: false };
export type ProfilePatchEditorResult =
  | { editor: ProfilePatchEditorDto; ok: true }
  | { error: ProfileClientError; ok: false };
export type ProfileRouteCatalogResult =
  | { catalog: ProfileRouteCatalogDto; ok: true }
  | { error: ProfileClientError; ok: false };

export interface ProfileDerivedAuthority {
  profileId: string;
  selectionRevision: number;
  semanticRevision: string;
}

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
  loadRoutes(
    authority: ProfileDerivedAuthority,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileRouteCatalogResult>;
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
  selectedProfileAuthority: ProfileDerivedAuthority | null;
  selectedProfileRevision: number;
  selectProfile(
    profileId: string,
    expectedSelection?: ProfileSelectionSnapshotDto,
  ): Promise<ProfileSelectionOperationResult>;
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

interface ProfileCommand {
  controller: AbortController;
  operation: CommandFeedbackOperation;
}

interface ProfileSelectionProjection {
  baseRevision: number;
  operation: CommandFeedbackOperation;
  profileId: string;
}

function profileCommandScope(snapshot: ProfileSnapshotDto | null) {
  return snapshot
    ? applicationCommandScope(snapshot.applicationOrder, "profile")
    : "profile:unconfirmed";
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
  const [selectionProjection, setSelectionProjection] = useState<ProfileSelectionProjection | null>(
    null,
  );
  const {
    begin: beginCommandFeedback,
    confirmAuthority: confirmCommandAuthority,
    isCurrent: isCurrentCommandFeedback,
    reset: resetCommandFeedback,
    resetPending: resetPendingCommandFeedback,
    state: commandFeedbackState,
    transition: transitionCommandFeedback,
  } = useCommandFeedback();
  const latestSnapshot = useRef<ProfileSnapshotDto | null>(null);
  const profileCommand = useRef<ProfileCommand | null>(null);
  const profileOperationKey = useRef<{ key: string; operationId: string } | null>(null);
  const selectionProjectionRef = useRef<ProfileSelectionProjection | null>(null);
  const snapshotAcceptance = useRef(new ApplicationSnapshotAcceptance<ProfileSnapshotDto>());
  const activationWaiters = useRef(
    new Map<
      string,
      {
        reject(error: ProfileClientError): void;
        resolve(activation: ProfileActivationSnapshotDto): void;
      }
    >(),
  );

  const updateSelectionProjection = useCallback((projection: ProfileSelectionProjection | null) => {
    selectionProjectionRef.current = projection;
    setSelectionProjection(projection);
  }, []);

  const acceptSnapshot = useCallback(
    (nextSnapshot: ProfileSnapshotDto, delivery: SnapshotDelivery) => {
      const current = latestSnapshot.current;
      const authorityChangedAtBaseline =
        delivery === "baseline" &&
        current !== null &&
        nextSnapshot.applicationOrder.authorityId !== current.applicationOrder.authorityId;
      const acceptedSelection =
        !authorityChangedAtBaseline &&
        current &&
        (nextSnapshot.selection.revision < current.selection.revision ||
          (nextSnapshot.selection.revision === current.selection.revision &&
            nextSnapshot.selection.profileId !== current.selection.profileId))
          ? current.selection
          : nextSnapshot.selection;
      if (acceptedSelection !== nextSnapshot.selection) {
        nextSnapshot = { ...nextSnapshot, selection: acceptedSelection };
      }
      const result = snapshotAcceptance.current.accept(nextSnapshot, delivery);
      if (result.kind === "stale" || result.kind === "duplicate") return false;
      if (result.kind === "conflict") {
        setError(new ProfileClientError("validation", "Profile snapshot order conflict"));
        return false;
      }
      nextSnapshot = result.snapshot;
      const command = profileCommand.current;
      if (command) {
        const nextScope = profileCommandScope(nextSnapshot);
        if (command.operation.scopeKey !== nextScope) {
          command.controller.abort();
          transitionCommandFeedback(command.operation, "superseded");
          if (profileCommand.current?.operation.operationId === command.operation.operationId) {
            profileCommand.current = null;
          }
        } else if (delivery !== "command") {
          if (
            confirmCommandAuthority(
              command.operation,
              applicationCommandAuthority(nextSnapshot.applicationOrder),
            )
          ) {
            command.controller.abort();
            if (profileCommand.current?.operation.operationId === command.operation.operationId) {
              profileCommand.current = null;
            }
          }
        }
      }
      latestSnapshot.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setError(null);
      const projection = selectionProjectionRef.current;
      if (!projection || acceptedSelection.revision > projection.baseRevision) {
        updateSelectionProjection(null);
      }
      const activation = nextSnapshot.activation;
      if (activation.phase === "pending" || !activation.commandId) return true;
      const waiter = activationWaiters.current.get(activation.commandId);
      if (!waiter) return true;
      activationWaiters.current.delete(activation.commandId);
      waiter.resolve(activation);
      return true;
    },
    [confirmCommandAuthority, transitionCommandFeedback, updateSelectionProjection],
  );

  useEffect(() => {
    const controller = new AbortController();
    snapshotAcceptance.current.clear();
    resetCommandFeedback("cancelled");
    profileCommand.current = null;
    profileOperationKey.current = null;
    updateSelectionProjection(null);
    const unsubscribeConnection = resolvedClient.subscribeConnection((nextConnection) => {
      if (nextConnection.phase === "connected") {
        if (nextConnection.stale) snapshotAcceptance.current.armReconnect();
        else snapshotAcceptance.current.confirmReconnect();
      }
      if (
        nextConnection.phase !== "connected" &&
        nextConnection.phase !== "fixture" &&
        nextConnection.stale
      ) {
        profileCommand.current?.controller.abort();
        profileCommand.current = null;
        resetPendingCommandFeedback("disconnected");
        for (const waiter of activationWaiters.current.values()) {
          waiter.reject(new ProfileClientError("disconnected", "Profile connection was lost"));
        }
        activationWaiters.current.clear();
      }
      setConnection(nextConnection);
    });
    const unsubscribeSnapshots = resolvedClient.subscribeSnapshots((nextSnapshot, delivery) =>
      acceptSnapshot(nextSnapshot, delivery ?? "update"),
    );
    resolvedClient
      .getSnapshot({ signal: controller.signal })
      .then((nextSnapshot) => acceptSnapshot(nextSnapshot, "request"))
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setError(toProfileClientError(failure));
      });
    return () => {
      controller.abort();
      profileCommand.current?.controller.abort();
      profileCommand.current = null;
      resetPendingCommandFeedback("cancelled");
      unsubscribeConnection();
      unsubscribeSnapshots();
      for (const waiter of activationWaiters.current.values()) {
        waiter.reject(new ProfileClientError("cancelled", "Profile activation wait cancelled"));
      }
      activationWaiters.current.clear();
    };
  }, [
    acceptSnapshot,
    resetCommandFeedback,
    resetPendingCommandFeedback,
    resolvedClient,
    updateSelectionProjection,
  ]);

  const beginProfileCommand = useCallback(
    (key: string) => {
      const current = latestSnapshot.current;
      const operation = beginCommandFeedback({
        confirmedAuthority: current
          ? applicationCommandAuthority(current.applicationOrder)
          : undefined,
        domainKey: "profile",
        scopeKey: profileCommandScope(current),
      });
      if (!operation) return null;
      const command = { controller: new AbortController(), operation };
      profileCommand.current = command;
      profileOperationKey.current = { key, operationId: operation.operationId };
      setError(null);
      return command;
    },
    [beginCommandFeedback],
  );

  const finishProfileCommand = useCallback((command: ProfileCommand) => {
    if (profileCommand.current?.operation.operationId === command.operation.operationId) {
      profileCommand.current = null;
    }
  }, []);

  const runMutation = useCallback(
    async (
      operation: Exclude<ProfileOperation, "preflight">,
      profileId: string | undefined,
      mutate: (signal: AbortSignal) => Promise<ProfileSnapshotDto>,
    ): Promise<ProfileOperationResult> => {
      const command = beginProfileCommand(operationKey(operation, profileId));
      if (!command) return conflict();
      try {
        const nextSnapshot = await mutate(command.controller.signal);
        if (!isCurrentCommandFeedback(command.operation, "pending")) {
          if (
            latestSnapshot.current &&
            hasSameApplicationOrder(latestSnapshot.current, nextSnapshot)
          ) {
            return { ok: true };
          }
          return cancelledResult();
        }
        acceptSnapshot(nextSnapshot, "command");
        if (isCurrentCommandFeedback(command.operation, "pending")) {
          transitionCommandFeedback(command.operation, "success");
        }
        return { ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        if (operation === "refresh" && isCurrentCommandFeedback(command.operation, "pending")) {
          try {
            const nextSnapshot = await resolvedClient.getSnapshot();
            if (isCurrentCommandFeedback(command.operation, "pending")) {
              acceptSnapshot(nextSnapshot, "request");
            }
          } catch {
            // Keep the previous safe snapshot when reconciliation also fails.
          }
        }
        if (isCurrentCommandFeedback(command.operation, "pending")) {
          setError(typedError);
          transitionCommandFeedback(command.operation, "failure");
        }
        return { error: typedError, ok: false };
      } finally {
        finishProfileCommand(command);
      }
    },
    [
      acceptSnapshot,
      beginProfileCommand,
      finishProfileCommand,
      isCurrentCommandFeedback,
      resolvedClient,
      transitionCommandFeedback,
    ],
  );

  const runPreflight = useCallback(
    async (
      preflight: (signal: AbortSignal) => Promise<ProfilePreviewDto | null>,
    ): Promise<ProfilePreviewResult> => {
      const command = beginProfileCommand(operationKey("preflight"));
      if (!command) return conflict();
      try {
        const preview = await preflight(command.controller.signal);
        if (!isCurrentCommandFeedback(command.operation, "pending")) {
          return cancelledPreview();
        }
        transitionCommandFeedback(command.operation, "success");
        return { ok: true, preview };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        if (isCurrentCommandFeedback(command.operation, "pending")) {
          setError(typedError);
          transitionCommandFeedback(command.operation, "failure");
        }
        return { error: typedError, ok: false };
      } finally {
        finishProfileCommand(command);
      }
    },
    [
      beginProfileCommand,
      finishProfileCommand,
      isCurrentCommandFeedback,
      transitionCommandFeedback,
    ],
  );

  const runProviderMutation = useCallback(
    async (
      providerId: string | undefined,
      mutate: (signal: AbortSignal) => ReturnType<ProfileClient["updateProvider"]>,
    ): Promise<ProfileOperationResult> => {
      const command = beginProfileCommand(operationKey("provider-update", providerId));
      if (!command) return conflict();
      try {
        const result = await mutate(command.controller.signal);
        if (!isCurrentCommandFeedback(command.operation, "pending")) {
          return cancelledResult();
        }
        setSnapshot((current) => (current ? { ...current, providers: result.snapshot } : current));
        if (result.phase !== "success") {
          transitionCommandFeedback(command.operation, "failure");
          return {
            error: new ProfileClientError("remote", "Provider update failed", true),
            ok: false,
          };
        }
        transitionCommandFeedback(command.operation, "success");
        return { ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        if (isCurrentCommandFeedback(command.operation, "pending")) {
          setError(typedError);
          transitionCommandFeedback(command.operation, "failure");
        }
        return { error: typedError, ok: false };
      } finally {
        finishProfileCommand(command);
      }
    },
    [
      beginProfileCommand,
      finishProfileCommand,
      isCurrentCommandFeedback,
      transitionCommandFeedback,
    ],
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
    async (
      authority: ProfileDerivedAuthority,
      options?: { signal?: AbortSignal },
    ): Promise<ProfileRouteCatalogResult> => {
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
        const catalog = await resolvedClient.getRoutes(authority.profileId, options);
        if (
          catalog.profileId !== authority.profileId ||
          catalog.fingerprint !== authority.semanticRevision
        ) {
          return {
            error: new ProfileClientError(
              "validation",
              "Configured routes do not match the selected Profile authority",
            ),
            ok: false,
          };
        }
        return { catalog, ok: true };
      } catch (failure) {
        if (options?.signal?.aborted) {
          return {
            error: new ProfileClientError("cancelled", "Configured route loading was cancelled"),
            ok: false,
          };
        }
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
      const command = beginProfileCommand(operationKey("patch-save", authority.profileId));
      if (!command) return conflict();
      try {
        const editor = await resolvedClient.replacePatches(authority, patches, {
          signal: command.controller.signal,
        });
        if (!isCurrentCommandFeedback(command.operation, "pending")) {
          return cancelledPatchEditor();
        }
        const nextSnapshot = await resolvedClient.getSnapshot({
          signal: command.controller.signal,
        });
        if (!isCurrentCommandFeedback(command.operation, "pending")) {
          return cancelledPatchEditor();
        }
        acceptSnapshot(nextSnapshot, "command");
        transitionCommandFeedback(command.operation, "success");
        return { editor, ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        if (isCurrentCommandFeedback(command.operation, "pending")) {
          setError(typedError);
          transitionCommandFeedback(command.operation, "failure");
        }
        return { error: typedError, ok: false };
      } finally {
        finishProfileCommand(command);
      }
    },
    [
      acceptSnapshot,
      beginProfileCommand,
      finishProfileCommand,
      isCurrentCommandFeedback,
      resolvedClient,
      transitionCommandFeedback,
    ],
  );

  const runActivation = useCallback(
    async (
      operation: "activate" | "stop",
      mutate: (signal: AbortSignal) => Promise<ProfileActivationSnapshotDto>,
      allowPending = false,
    ): Promise<ProfileOperationResult> => {
      if (!allowPending && snapshot?.activation.phase === "pending") {
        return conflict();
      }
      const command = beginProfileCommand(operationKey(operation));
      if (!command) return conflict();
      try {
        const activation = await mutate(command.controller.signal);
        if (!isCurrentCommandFeedback(command.operation, "pending")) {
          if (
            activation.commandId &&
            latestSnapshot.current?.activation.commandId === activation.commandId
          ) {
            return { ok: true };
          }
          return cancelledResult();
        }
        const current = latestSnapshot.current;
        const alreadyCompleted =
          current?.activation.commandId === activation.commandId &&
          current.activation.phase !== "pending";
        if (current && !alreadyCompleted) {
          const optimistic = { ...current, activation };
          latestSnapshot.current = optimistic;
          setSnapshot(optimistic);
        }
        transitionCommandFeedback(command.operation, "success");
        return { ok: true };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        if (isCurrentCommandFeedback(command.operation, "pending")) {
          setError(typedError);
          transitionCommandFeedback(command.operation, "failure");
        }
        return { error: typedError, ok: false };
      } finally {
        finishProfileCommand(command);
      }
    },
    [
      beginProfileCommand,
      finishProfileCommand,
      isCurrentCommandFeedback,
      snapshot?.activation.phase,
      transitionCommandFeedback,
    ],
  );

  const waitForProfileActivation = useCallback(
    async (profileId: string): Promise<ProfileOperationResult> => {
      const activation = latestSnapshot.current?.activation;
      if (!activation || activation.targetProfileId !== profileId) return conflict();
      if (activation.phase !== "pending") {
        return activation.phase === "success"
          ? { ok: true }
          : activationFailure(activation.failure, activation.failureEndpoint);
      }
      if (!activation.commandId) return conflict();
      try {
        const completed = await new Promise<ProfileActivationSnapshotDto>((resolve, reject) => {
          activationWaiters.current.set(activation.commandId!, { reject, resolve });
          // The terminal snapshot can arrive between the initial read above and
          // waiter registration. Re-read the single activation authority so a
          // first launch never needs a second user command to converge.
          const current = latestSnapshot.current?.activation;
          if (current?.commandId === activation.commandId && current.phase !== "pending") {
            activationWaiters.current.delete(activation.commandId!);
            resolve(current);
          }
        });
        return completed.phase === "success"
          ? { ok: true }
          : activationFailure(completed.failure, completed.failureEndpoint);
      } catch (failure) {
        return { error: toProfileClientError(failure), ok: false };
      }
    },
    [],
  );

  const selectProfile = useCallback(
    async (
      profileId: string,
      expectedSelection?: ProfileSelectionSnapshotDto,
    ): Promise<ProfileSelectionOperationResult> => {
      const current = latestSnapshot.current;
      if (!current?.profiles.some((profile) => profile.id === profileId && profile.status.valid)) {
        return {
          error: new ProfileClientError("not-found", "The selected Profile is unavailable"),
          ok: false,
        };
      }
      if (
        !expectedSelection &&
        current.selection.profileId === profileId &&
        !profileCommand.current
      ) {
        return { ok: true, selection: current.selection };
      }
      const command = beginProfileCommand(operationKey("select", profileId));
      if (!command) return conflict();
      const projection = {
        baseRevision: current.selection.revision,
        operation: command.operation,
        profileId,
      };
      if (!expectedSelection) updateSelectionProjection(projection);
      try {
        const confirmed = await resolvedClient.selectProfile(profileId, {
          expectedSelection,
          signal: command.controller.signal,
        });
        if (!isCurrentCommandFeedback(command.operation, "pending")) {
          const authoritativeSelection = latestSnapshot.current?.selection;
          if (
            authoritativeSelection?.profileId === profileId &&
            authoritativeSelection.revision > current.selection.revision
          ) {
            return { ok: true, selection: authoritativeSelection };
          }
          return cancelledSelection();
        }
        acceptSnapshot(confirmed, "command");
        if (!isCurrentCommandFeedback(command.operation, "pending")) {
          return cancelledSelection();
        }
        if (expectedSelection && confirmed.selection.profileId !== profileId) {
          transitionCommandFeedback(command.operation, "failure");
          return conflict();
        }
        transitionCommandFeedback(command.operation, "success");
        return { ok: true, selection: confirmed.selection };
      } catch (failure) {
        const typedError = toProfileClientError(failure);
        if (isCurrentCommandFeedback(command.operation, "pending")) {
          setError(typedError);
          transitionCommandFeedback(command.operation, "failure");
        }
        return { error: typedError, ok: false };
      } finally {
        if (
          selectionProjectionRef.current?.operation.operationId === command.operation.operationId
        ) {
          updateSelectionProjection(null);
        }
        finishProfileCommand(command);
      }
    },
    [
      acceptSnapshot,
      beginProfileCommand,
      finishProfileCommand,
      isCurrentCommandFeedback,
      resolvedClient,
      transitionCommandFeedback,
      updateSelectionProjection,
    ],
  );

  const pendingFeedback = commandFeedbackState.operations.get("profile");
  const pendingKey =
    pendingFeedback?.phase === "pending" &&
    profileOperationKey.current?.operationId === pendingFeedback.operationId
      ? profileOperationKey.current.key
      : null;
  const selectedProfileId =
    selectionProjection &&
    pendingFeedback?.phase === "pending" &&
    selectionProjection.operation.operationId === pendingFeedback.operationId
      ? selectionProjection.profileId
      : (snapshot?.selection.profileId ?? null);
  const selectedProfileAuthority = useMemo<ProfileDerivedAuthority | null>(() => {
    if (
      !snapshot ||
      connection.stale ||
      (connection.phase !== "connected" && connection.phase !== "fixture")
    ) {
      return null;
    }
    const profileId = snapshot.selection.profileId;
    if (!profileId) return null;
    const selectedProfile = snapshot.profiles.find(
      (profile) => profile.id === profileId && profile.status.valid,
    );
    if (!selectedProfile) return null;
    return {
      profileId,
      selectionRevision: snapshot.selection.revision,
      semanticRevision: selectedProfile.effectiveFingerprint,
    };
  }, [connection.phase, connection.stale, snapshot]);

  const value = useMemo<ProfileContextValue>(
    () => ({
      activateProfile: async (profileId) => {
        const selected = await selectProfile(profileId);
        if (!selected.ok) return selected;
        return runActivation("activate", (signal) =>
          resolvedClient.activateProfile(crypto.randomUUID(), profileId, { signal }),
        );
      },
      cancelActivation: () => {
        const commandId = snapshot?.activation.commandId;
        if (!commandId) return Promise.resolve(conflict());
        return runActivation(
          "activate",
          (signal) => resolvedClient.cancelActivation(commandId, { signal }),
          true,
        );
      },
      connection,
      createProfile: (fileName) =>
        resolvedClient.createProfile
          ? runMutation("create", undefined, (signal) =>
              resolvedClient.createProfile!(fileName, { signal }),
            )
          : Promise.resolve({
              error: new ProfileClientError("unsupported", "Profile creation is unavailable"),
              ok: false as const,
            }),
      createProfileAvailable: Boolean(resolvedClient.createProfile),
      deleteProfile: (profileId) =>
        runMutation("delete", profileId, (signal) =>
          resolvedClient.deleteProfile(profileId, { signal }),
        ),
      detachSubscription: (profileId) =>
        resolvedClient.detachSubscription
          ? runMutation("detach", profileId, (signal) =>
              resolvedClient.detachSubscription!(profileId, { signal }),
            )
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
        return profileId
          ? pendingKey === operationKey(operation, profileId)
          : pendingKey === operation || pendingKey?.startsWith(`${operation}:`) === true;
      },
      loadPatches,
      loadRoutes,
      openProfileDirectory: () =>
        runFileAction(
          resolvedClient.openProfileDirectory
            ? () => resolvedClient.openProfileDirectory!()
            : undefined,
        ),
      preflightHttps: (url, label) =>
        runPreflight((signal) => resolvedClient.preflightHttps(url, label, { signal })),
      preflightLocal: (label) => runPreflight(() => resolvedClient.preflightLocal(label)),
      refreshProfile: (profileId) =>
        runMutation("refresh", profileId, (signal) =>
          resolvedClient.refreshProfile(profileId, { signal }),
        ),
      replacePatches,
      setRefreshPolicy: (profileId, policy) =>
        runMutation("schedule", profileId, (signal) =>
          resolvedClient.setRefreshPolicy(profileId, policy, { signal }),
        ),
      savePreview: (previewId) =>
        runMutation("save", undefined, (signal) =>
          resolvedClient.savePreview(previewId, { signal }),
        ),
      selectedProfileId,
      selectedProfileAuthority,
      selectedProfileRevision: snapshot?.selection.revision ?? 0,
      selectProfile,
      snapshot,
      stopActiveProfile: () =>
        runActivation("stop", (signal) =>
          resolvedClient.stopActiveProfile(crypto.randomUUID(), { signal }),
        ),
      updateAllProviders: (authority, kind) =>
        runProviderMutation(kind, (signal) =>
          resolvedClient.updateAllProviders(authority, kind, { signal }),
        ),
      updateProvider: (authority, providerId) =>
        runProviderMutation(providerId, (signal) =>
          resolvedClient.updateProvider(authority, providerId, { signal }),
        ),
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
      selectedProfileAuthority,
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

function cancelledResult(): ProfileOperationResult {
  return { error: cancelledError(), ok: false };
}

function cancelledSelection(): ProfileSelectionOperationResult {
  return { error: cancelledError(), ok: false };
}

function cancelledPreview(): ProfilePreviewResult {
  return { error: cancelledError(), ok: false };
}

function cancelledPatchEditor(): ProfilePatchEditorResult {
  return { error: cancelledError(), ok: false };
}

function cancelledError() {
  return new ProfileClientError(
    "cancelled",
    "The Profile operation was replaced before it completed",
    true,
  );
}

function hasSameApplicationOrder(left: ProfileSnapshotDto, right: ProfileSnapshotDto) {
  return (
    left.applicationOrder.authorityId === right.applicationOrder.authorityId &&
    left.applicationOrder.epoch === right.applicationOrder.epoch &&
    left.applicationOrder.order === right.applicationOrder.order
  );
}

function activationFailure(
  failure: ProfileActivationSnapshotDto["failure"],
  endpoint: ProfileActivationSnapshotDto["failureEndpoint"],
) {
  const detail = failure === "managed-listener-conflict" && endpoint ? ` at ${endpoint}` : "";
  return {
    error: new ProfileClientError(
      "remote",
      `Profile activation failed: ${failure ?? "unknown"}${detail}`,
    ),
    ok: false,
  } as const;
}

function toProfileClientError(error: unknown) {
  if (error instanceof ProfileClientError) return error;
  return new ProfileClientError("unknown", "Unknown profile operation failure");
}
