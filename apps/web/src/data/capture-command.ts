import type { CaptureSelectionDto } from "@mish/contracts";
import { useCallback } from "react";
import { useProduct } from "./product-provider";

export function useCaptureCommand() {
  const product = useProduct();

  const setCapture = useCallback(
    async (selection: CaptureSelectionDto, active: boolean) => {
      return product.setCapture(selection, active);
    },
    [product],
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
