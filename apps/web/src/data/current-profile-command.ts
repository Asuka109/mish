import { ProfileClientError } from "@mish/contracts";
import { useCallback, useState } from "react";
import { useOptionalProfiles, type ProfileOperationResult } from "./profile-provider";
import { useProduct } from "./product-provider";

export function useCurrentProfileCommand() {
  const product = useProduct();
  const profiles = useOptionalProfiles();
  const [switching, setSwitching] = useState(false);

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

      profiles.selectProfile(profileId);

      const runtime = product.snapshot?.runtime;
      const proxyRunning = Boolean(runtime?.systemProxyEnabled || runtime?.tunEnabled);
      const activeProfileId = profiles.snapshot.activation.activeProfileId;
      if (!proxyRunning || activeProfileId === profileId) return { ok: true };

      const canSwitchRuntime =
        product.snapshot?.adapterKind === "rpc" &&
        profiles.snapshot.capabilities.activation === "supported" &&
        profiles.snapshot.activation.availability === "available";
      if (!canSwitchRuntime) {
        if (previousProfileId) profiles.selectProfile(previousProfileId);
        return {
          error: new ProfileClientError(
            "unsupported",
            "The running Core cannot switch profiles in the current runtime",
          ),
          ok: false,
        };
      }

      setSwitching(true);
      try {
        const activation = await profiles.activateProfile(profileId);
        if (!activation.ok) {
          if (previousProfileId) profiles.selectProfile(previousProfileId);
          return activation;
        }

        const completed = await profiles.waitForProfileActivation(profileId);
        if (!completed.ok && previousProfileId) profiles.selectProfile(previousProfileId);
        return completed;
      } finally {
        setSwitching(false);
      }
    },
    [product.snapshot, profiles],
  );

  return {
    pending: switching || (profiles?.isPending("activate") ?? false),
    selectCurrentProfile,
  };
}
