import type { CaptureSelectionDto } from "@mish/contracts";
import { useCallback } from "react";
import { useOptionalProfiles } from "./profile-provider";
import { useProduct } from "./product-provider";

export function useCaptureCommand() {
  const product = useProduct();
  const profiles = useOptionalProfiles();

  const setCapture = useCallback(
    async (selection: CaptureSelectionDto, active: boolean) => {
      return product.setCapture(
        selection,
        active,
        active ? (profiles?.selectedProfileId ?? undefined) : undefined,
      );
    },
    [product, profiles?.selectedProfileId],
  );

  return {
    pending:
      product.isCommandPending("capture") ||
      product.snapshot?.runtime.captureOperation.phase === "pending" ||
      product.snapshot?.runtime.systemProxy.phase === "pending" ||
      product.snapshot?.runtime.tun.phase === "pending" ||
      false,
    setCapture,
  };
}
