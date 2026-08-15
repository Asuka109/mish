import type { EventValue, HandshakeOutput, InvokeOutput } from "@mish/poc-orpc";

/**
 * The only object that crosses the isolated-world boundary.
 *
 * It intentionally exposes no Electron object, IPC channel, MessagePort, or
 * alternate transport. The preload owns the oRPC session and presents only the
 * bounded admission operations needed by the renderer fixture.
 */
export interface ElectronAdmissionApi {
  readonly runOrpcAdmission: () => Promise<OrpcAdmissionResult>;
  readonly reportStore: (event: StoreReport) => void;
  readonly reportFailure: (report: RendererFailureReport) => void;
  readonly rendererReady: (report: RendererReadyReport) => void;
}

export interface OrpcAdmissionResult {
  readonly handshake: HandshakeOutput;
  readonly invocation: InvokeOutput;
  readonly events: readonly EventValue[];
  readonly cleanup: "iterator-returned";
}

export type StoreReport =
  | { readonly kind: "store-mounted"; readonly label: "first" | "remount" }
  | { readonly kind: "store-notified"; readonly count: number }
  | { readonly kind: "store-batched"; readonly count: number }
  | { readonly kind: "store-cleaned"; readonly label: "first" | "remount" };

export interface RendererReadyReport {
  readonly orpc: OrpcAdmissionResult;
  readonly store: {
    readonly notifications: number;
    readonly cleanups: number;
    readonly remounted: true;
  };
}

export type RendererFailureStage = "port" | "handshake" | "invoke" | "events" | "renderer";

export interface RendererFailureReport {
  readonly stage: RendererFailureStage;
  readonly message: "admission-failed";
}

export const ADMISSION_IPC_CHANNEL = "mish-electron/admission-port" as const;
export const REPORT_IPC_CHANNEL = "mish-electron/renderer-report" as const;
export const FAILURE_IPC_CHANNEL = "mish-electron/renderer-failure" as const;
export const READY_IPC_CHANNEL = "mish-electron/renderer-ready" as const;

declare global {
  interface Window {
    readonly mishElectron: ElectronAdmissionApi;
  }
}
