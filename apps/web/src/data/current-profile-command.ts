import { ProfileClientError } from "@mish/contracts";
import { useCallback, useEffect } from "react";
import { applicationCommandScope, useCommandFeedback } from "./command-feedback";
import { useOptionalProfiles, type ProfileOperationResult } from "./profile-provider";
import { useProduct } from "./product-provider";

export function useCurrentProfileCommand() {
  const product = useProduct();
  const profiles = useOptionalProfiles();
  const {
    begin: beginCommandFeedback,
    isCurrent: isCurrentCommandFeedback,
    state: commandFeedbackState,
    transition: transitionCommandFeedback,
  } = useCommandFeedback();
  const switching = commandFeedbackState.operations.get("current-profile");

  useEffect(() => {
    if (!profiles?.snapshot || switching?.phase !== "pending") return;
    const scopeKey = applicationCommandScope(profiles.snapshot.applicationOrder, "current-profile");
    if (switching.scopeKey !== scopeKey) {
      transitionCommandFeedback(switching, "superseded");
    }
  }, [profiles?.snapshot, switching, transitionCommandFeedback]);

  const selectCurrentProfile = useCallback(
    async (profileId: string): Promise<ProfileOperationResult> => {
      if (!profiles?.snapshot) {
        return {
          error: new ProfileClientError("disconnected", "Saved profiles are unavailable"),
          ok: false,
        };
      }

      const previousProfileId = profiles.selectedProfileId;
      if (profileId === previousProfileId) return { ok: true };

      const selected = await profiles.selectProfile(profileId);
      if (!selected.ok) return selected;
      const rollbackSelection = () =>
        previousProfileId
          ? profiles.selectProfile(previousProfileId, selected.selection)
          : Promise.resolve({ ok: true, selection: selected.selection } as const);

      const runtime = product.snapshot?.runtime;
      const proxyRunning = Boolean(runtime?.systemProxyEnabled || runtime?.tunEnabled);
      const activeProfileId = profiles.snapshot.activation.activeProfileId;
      if (!proxyRunning || activeProfileId === profileId) return { ok: true };

      const canSwitchRuntime =
        product.snapshot?.adapterKind === "rpc" &&
        profiles.snapshot.capabilities.activation === "supported" &&
        profiles.snapshot.activation.availability === "available";
      if (!canSwitchRuntime) {
        await rollbackSelection();
        return {
          error: new ProfileClientError(
            "unsupported",
            "The running Core cannot switch profiles in the current runtime",
          ),
          ok: false,
        };
      }

      const operation = beginCommandFeedback({
        domainKey: "current-profile",
        scopeKey: applicationCommandScope(profiles.snapshot.applicationOrder, "current-profile"),
      });
      if (!operation) {
        return {
          error: new ProfileClientError(
            "conflict",
            "Another current Profile operation is already pending",
            true,
          ),
          ok: false,
        };
      }

      const activation = await profiles.activateProfile(profileId);
      if (!isCurrentCommandFeedback(operation, "pending")) {
        return replacedCurrentProfileOperation();
      }
      if (!activation.ok) {
        await rollbackSelection();
        if (isCurrentCommandFeedback(operation, "pending")) {
          transitionCommandFeedback(operation, "failure");
        }
        return activation;
      }

      const completed = await profiles.waitForProfileActivation(profileId);
      if (!isCurrentCommandFeedback(operation, "pending")) {
        return replacedCurrentProfileOperation();
      }
      if (!completed.ok) await rollbackSelection();
      if (isCurrentCommandFeedback(operation, "pending")) {
        transitionCommandFeedback(operation, completed.ok ? "success" : "failure");
      }
      return completed;
    },
    [
      beginCommandFeedback,
      isCurrentCommandFeedback,
      product.snapshot,
      profiles,
      transitionCommandFeedback,
    ],
  );

  return {
    pending:
      switching?.phase === "pending" ||
      (profiles?.isPending("activate") ?? false) ||
      (profiles?.isPending("select") ?? false),
    selectCurrentProfile,
  };
}

function replacedCurrentProfileOperation(): ProfileOperationResult {
  return {
    error: new ProfileClientError(
      "cancelled",
      "The current Profile operation was replaced before it completed",
      true,
    ),
    ok: false,
  };
}
