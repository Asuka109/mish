import type {
  OrpcEventValue,
  OrpcHandshakeOutput,
  OrpcInvokeOutput,
  OrpcOperation,
} from "@mish/contracts";
import type { RendererProductReport } from "./product-surface.js";

export const ELECTRON_PORT_CHANNEL = "mish-electron/session-port" as const;
export const ELECTRON_PORT_REQUEST_CHANNEL = "mish-electron/request-session-port" as const;
export const ELECTRON_REPORT_CHANNEL = "mish-electron/renderer-report" as const;
export const ELECTRON_FAILURE_CHANNEL = "mish-electron/renderer-failure" as const;
export const ELECTRON_READY_CHANNEL = "mish-electron/renderer-ready" as const;
export const ELECTRON_DISPOSED_CHANNEL = "mish-electron/renderer-disposed" as const;

export type RendererFailureStage = "port" | "handshake" | "invoke" | "events" | "renderer";

export interface RendererFailureReport {
  readonly stage: RendererFailureStage;
  readonly message: "admission-failed";
}

export type RendererStoreReport =
  | { readonly kind: "store-mounted"; readonly label: "first" | "remount" }
  | { readonly kind: "store-notified"; readonly count: number }
  | { readonly kind: "store-batched"; readonly count: number }
  | { readonly kind: "store-cleaned"; readonly label: "first" | "remount" };

export interface RendererReadyReport {
  readonly session: {
    readonly connected: true;
    readonly generation: number;
    readonly parentEpoch: number;
    readonly revision: number;
  };
  readonly events: number;
  readonly store: {
    readonly notifications: number;
    readonly cleanups: number;
    readonly remounted: true;
  };
  readonly strictMode: true;
  readonly product: RendererProductReport;
}

export type RendererReadyDisposition = "keep-session" | "dispose-and-quit";

export interface ElectronSessionMetadata {
  readonly state:
    | "authenticating"
    | "connected-current"
    | "connected-stale"
    | "connecting"
    | "disconnected"
    | "disposed";
  readonly sessionGeneration: number;
  readonly parentEpoch: number;
  readonly revision: number;
}

export type ElectronEventListener = (event: OrpcEventValue) => void;
export type ElectronEventClosedListener = () => void;

/**
 * The only object exposed to the isolated renderer world. It contains typed
 * session operations and bounded semantic reports, but no Electron, IPC,
 * transport, port, token, or Node primitive.
 */
export interface ElectronHostApi {
  readonly connect: () => Promise<OrpcHandshakeOutput>;
  readonly invoke: (operation: OrpcOperation, deadlineMs?: number) => Promise<OrpcInvokeOutput>;
  readonly watchEvents: (
    onEvent: ElectronEventListener,
    onClosed: ElectronEventClosedListener,
  ) => Promise<void>;
  readonly stopEvents: () => Promise<void>;
  readonly disconnect: () => void;
  readonly dispose: () => Promise<void>;
  readonly getSessionMetadata: () => ElectronSessionMetadata;
  readonly reportStore: (report: RendererStoreReport) => void;
  readonly reportFailure: (report: RendererFailureReport) => void;
  readonly rendererReady: (report: RendererReadyReport) => Promise<RendererReadyDisposition>;
  readonly rendererDisposed: () => void;
}

declare global {
  interface Window {
    readonly mishElectron: ElectronHostApi;
  }
}
