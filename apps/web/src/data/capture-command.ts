import type { CaptureSelectionDto } from "@mish/contracts";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useI18nContext } from "../i18n/i18n-react";
import { useOptionalProfiles } from "./profile-provider";
import { useProduct } from "./product-provider";

export function useCaptureCommand() {
  const product = useProduct();
  const profiles = useOptionalProfiles();
  const { LL } = useI18nContext();
  const [startingProfile, setStartingProfile] = useState(false);

  const setCapture = useCallback(
    async (selection: CaptureSelectionDto, active: boolean) => {
      const status = product.snapshot;
      const profileSnapshot = profiles?.snapshot;
      const captureActive = Boolean(
        status?.runtime.systemProxyEnabled || status?.runtime.tunEnabled,
      );
      const needsProfileStart =
        active &&
        !captureActive &&
        status?.adapterKind === "rpc" &&
        (status.runtime.phase === "inactive" ||
          status.runtime.phase === "error" ||
          profileSnapshot?.activation.activeProfileId !== profiles?.selectedProfileId);

      if (!needsProfileStart || !profileSnapshot) {
        return product.setCapture(selection, active);
      }

      const selectedProfileId = profiles.selectedProfileId;

      if (
        !selectedProfileId ||
        profileSnapshot.capabilities.activation !== "supported" ||
        profileSnapshot.activation.availability !== "available"
      ) {
        return product.setCapture(selection, active);
      }

      setStartingProfile(true);
      try {
        const activation =
          profileSnapshot.activation.phase === "pending" &&
          profileSnapshot.activation.targetProfileId === selectedProfileId
            ? { ok: true as const }
            : await profiles.activateProfile(selectedProfileId);
        if (!activation.ok) {
          toast.error(LL.profiles.activationFailed());
          return activation;
        }
        const completed = await profiles.waitForProfileActivation(selectedProfileId);
        if (!completed.ok) {
          toast.error(LL.profiles.activationFailed());
          return completed;
        }
        return product.setCapture(selection, true);
      } finally {
        setStartingProfile(false);
      }
    },
    [LL, product, profiles],
  );

  return {
    pending:
      startingProfile ||
      product.isCommandPending("capture") ||
      product.snapshot?.runtime.systemProxy.phase === "pending" ||
      product.snapshot?.runtime.tun.phase === "pending" ||
      (profiles?.isPending("activate") ?? false),
    setCapture,
  };
}
