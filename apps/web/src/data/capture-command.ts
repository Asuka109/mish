import type { CaptureFailureKind, CaptureSelectionDto } from "@mish/contracts";
import { useCallback } from "react";
import { useProduct } from "./product-provider";

export interface CaptureActionFeedback {
  busy: boolean;
  failure: CaptureFailureKind | null;
  operationId: string | null;
  phase: "error" | "finalizing" | "idle" | "pending" | "success";
}

export function useCaptureCommand() {
  const product = useProduct();
  const operation = product.snapshot?.runtime.captureOperation;
  const locallyPending = product.commandStates.capture.phase === "pending";
  const locallyFailed = product.commandStates.capture.phase === "failure";
  const phase: CaptureActionFeedback["phase"] = operation
    ? operation.phase === "finalizing"
      ? "finalizing"
      : operation.phase === "pending" || locallyPending
        ? "pending"
        : locallyFailed || operation.phase === "failed" || operation.phase === "recovery-required"
          ? "error"
          : operation.phase === "applied"
            ? "success"
            : "idle"
    : locallyPending
      ? "pending"
      : locallyFailed
        ? "error"
        : "idle";

  const setCapture = useCallback(
    async (selection: CaptureSelectionDto, active: boolean) => {
      return product.setCapture(selection, active);
    },
    [product],
  );

  const feedback: CaptureActionFeedback = {
    busy: phase === "pending" || phase === "finalizing",
    failure: operation?.failure ?? null,
    operationId: operation?.operationId ?? null,
    phase,
  };

  return {
    feedback,
    pending: feedback.busy,
    setCapture,
  };
}
