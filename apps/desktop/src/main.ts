import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { implement } from "@orpc/server";
import { RPCHandler as MessagePortRPCHandler } from "@orpc/server/message-port";
import {
  ORPC_CLIENT_NAMES,
  ORPC_CONTRACT_VERSION,
  ORPC_OPERATIONS,
  ORPC_PROTOCOL_VERSION,
  orpcContract,
  type OrpcEventReturn,
  type OrpcEventValue,
  type OrpcHandshakeOutput,
  type OrpcOperation,
} from "@mish/contracts";
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  ipcMain,
  type IpcMainEvent,
  type MessagePortMain,
} from "electron";

import {
  ELECTRON_DISPOSED_CHANNEL,
  ELECTRON_FAILURE_CHANNEL,
  ELECTRON_PORT_CHANNEL,
  ELECTRON_PORT_REQUEST_CHANNEL,
  ELECTRON_READY_CHANNEL,
  ELECTRON_REPORT_CHANNEL,
  type RendererFailureReport,
  type RendererReadyReport,
  type RendererReadyDisposition,
  type RendererStoreReport,
} from "./electron-api.js";
import {
  electronCorrelation,
  electronProjectionOperation,
  ElectronTranscript,
  replayElectronTranscript,
  type ElectronTranscriptOperation,
  type ElectronTranscriptResult,
} from "./transcript.js";
import {
  createElectronProjectionAuthority,
  ElectronProjectionError,
  type ElectronProjectionAuthority,
} from "./projection.js";
import {
  quitDecision,
  type ElectronHostMode,
  type ElectronHostSignal,
} from "./host-quit-policy.js";

const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_DEADLINE_MS = 1_000;
const RENDERER_READY_DEADLINE_MS = 10_000;
const QUIT_DEADLINE_MS = 5_000;
const runtimeProcess = Reflect.get(globalThis, "process") as
  | { readonly env?: Readonly<Record<string, string | undefined>> }
  | undefined;
const HOST_MODE: ElectronHostMode =
  runtimeProcess?.env?.["MISH_ELECTRON_FIXTURE_MODE"] === "auto-quit"
    ? "fixture-auto-quit"
    : "default";

type HostStage =
  | "starting"
  | "window-created"
  | "port-sent"
  | "renderer-ready"
  | "quit-requested"
  | "quitting"
  | "quit";

interface HostMetrics {
  activeStreams: number;
  cleanupCount: number;
  portCount: number;
  reportCount: number;
}

interface SessionPortState {
  readonly authToken: string;
  readonly projection: ElectronProjectionAuthority;
  readonly transcript: ElectronTranscript;
  readonly metrics: HostMetrics;
  generation: number;
  parentEpoch: number;
  revision: number;
  activePort?: MessagePortMain;
}

interface PortEnvelope {
  readonly authToken: string;
  readonly generation: number;
  readonly parentEpoch: number;
  readonly revision: number;
}

let mainWindow: BrowserWindow | undefined;
let sessionState: SessionPortState | undefined;
let rendererReady = false;
let rendererDisposed = false;
let failureReported = false;
let quitRequested = false;
let stage: HostStage = "starting";
let rendererReadyDeadline: ReturnType<typeof setTimeout> | undefined;
let quitDeadline: ReturnType<typeof setTimeout> | undefined;
const ports = new Set<MessagePortMain>();
const transcript = new ElectronTranscript(128);
const metrics: HostMetrics = {
  activeStreams: 0,
  cleanupCount: 0,
  portCount: 0,
  reportCount: 0,
};

function diagnostic(message: string): void {
  console.error(`MISH_ELECTRON_DIAGNOSTIC ${message}`);
}

function record(
  operation: ElectronTranscriptOperation,
  effect: "invocation" | "result" | "event" | "cleanup",
  result: ElectronTranscriptResult,
): void {
  transcript.record({
    operation,
    effect,
    result,
    correlationId: electronCorrelation(transcript.snapshot().length + 1),
  });
}

function protocolError(
  code: string,
  status: number,
): Error & { readonly code: string; readonly status: number } {
  const error = new Error(code) as Error & { readonly code: string; readonly status: number };
  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    status: { value: status, enumerable: true },
  });
  return error;
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createHostRouter(state: SessionPortState) {
  const implementation = implement(orpcContract);
  return implementation.router({
    session: {
      handshake: implementation.session.handshake.handler(({ input }) => {
        if (input.authToken !== state.authToken) {
          throw protocolError("UNAUTHORIZED", 401);
        }
        if (!ORPC_CLIENT_NAMES.includes(input.clientName)) {
          throw protocolError("FORBIDDEN", 403);
        }
        if (input.clientName !== "electron") {
          throw protocolError("FORBIDDEN", 403);
        }
        if (input.protocolVersion !== ORPC_PROTOCOL_VERSION) {
          throw protocolError("CONFLICT", 409);
        }
        if (input.requestedDeadlineMs < 1 || input.requestedDeadlineMs > MAX_DEADLINE_MS) {
          throw protocolError("TIMEOUT", 408);
        }
        if (
          input.requestedMaxMessageBytes < 128 ||
          input.requestedMaxMessageBytes > MAX_MESSAGE_BYTES
        ) {
          throw protocolError("PAYLOAD_TOO_LARGE", 413);
        }
        state.projection.setAvailable();
        record("orpc.handshake", "result", "accepted");
        return {
          contractVersion: ORPC_CONTRACT_VERSION,
          maxDeadlineMs: MAX_DEADLINE_MS,
          maxMessageBytes: MAX_MESSAGE_BYTES,
          parentEpoch: state.parentEpoch,
          protocolVersion: ORPC_PROTOCOL_VERSION,
          revision: state.revision,
          sessionGeneration: state.generation,
        } satisfies OrpcHandshakeOutput;
      }),
    },
    application: {
      invoke: implementation.application.invoke.handler(({ input, signal }) => {
        record("orpc.invoke", "invocation", "accepted");
        try {
          const result = state.projection.invoke(input, signal);
          record(result.transcriptOperation, "result", result.result);
          return {
            correlationId: input.correlationId,
            data: result.data,
            operation: result.operation,
            parentEpoch: state.parentEpoch,
            revision: state.revision,
            sessionGeneration: state.generation,
            value: "accepted" as const,
          };
        } catch (error) {
          if (error instanceof ElectronProjectionError) {
            const result =
              error.code === "CLIENT_CLOSED_REQUEST"
                ? "cancelled"
                : error.code === "TIMEOUT"
                  ? "deadline-exceeded"
                  : error.code === "PAYLOAD_TOO_LARGE"
                    ? "oversized"
                    : error.code === "CONFLICT"
                      ? "stale"
                      : "rejected";
            const operation =
              typeof input.operation === "string" &&
              ORPC_OPERATIONS.includes(input.operation as OrpcOperation)
                ? electronProjectionOperation(input.operation as OrpcOperation)
                : "orpc.invoke";
            record(operation, "result", result);
            throw protocolError(error.code, error.status);
          }
          record("orpc.invoke", "result", "rejected");
          throw error;
        }
      }),
      events: {
        watch: implementation.application.events.watch.handler(async function* ({
          input,
          signal,
        }): AsyncGenerator<OrpcEventValue, OrpcEventReturn, void> {
          if (
            input.sessionGeneration !== state.generation ||
            input.parentEpoch !== state.parentEpoch ||
            input.revision !== state.revision
          ) {
            throw protocolError("CONFLICT", 409);
          }
          state.metrics.activeStreams += 1;
          record("orpc.events", "invocation", "accepted");
          try {
            const values: readonly OrpcEventValue[] = [
              {
                correlationId: input.correlationId,
                parentEpoch: state.parentEpoch,
                revision: state.revision,
                sequence: 1,
                sessionGeneration: state.generation,
                value: "ready",
              },
              {
                correlationId: input.correlationId,
                parentEpoch: state.parentEpoch,
                revision: state.revision,
                sequence: 2,
                sessionGeneration: state.generation,
                value: "changed",
              },
            ];
            const closed = (): OrpcEventReturn => ({
              correlationId: input.correlationId,
              parentEpoch: state.parentEpoch,
              revision: state.revision,
              sessionGeneration: state.generation,
              value: "closed",
            });
            for (const value of values) {
              if (signal?.aborted) return closed();
              record("orpc.events", "event", "event");
              yield value;
            }
            await waitForAbort(signal);
            return closed();
          } finally {
            state.metrics.activeStreams = Math.max(0, state.metrics.activeStreams - 1);
            state.metrics.cleanupCount += 1;
            record("orpc.events", "cleanup", "cleaned-up");
          }
        }),
      },
    },
  });
}

function clearRendererReadyDeadline(): void {
  if (!rendererReadyDeadline) return;
  clearTimeout(rendererReadyDeadline);
  rendererReadyDeadline = undefined;
}

function clearQuitDeadline(): void {
  if (!quitDeadline) return;
  clearTimeout(quitDeadline);
  quitDeadline = undefined;
}

function closePorts(): void {
  for (const port of ports) {
    try {
      port.close();
    } catch {
      // A renderer can close its side first; host shutdown remains idempotent.
    }
  }
  ports.clear();
  sessionState?.projection.dispose();
  sessionState = undefined;
}

function requestQuit(): void {
  if (quitRequested) return;
  quitRequested = true;
  stage = "quit-requested";
  record("application.quit", "invocation", "accepted");
  quitDeadline = setTimeout(() => {
    diagnostic("phase=quit stage=deadline-exceeded");
    app.exit(1);
  }, QUIT_DEADLINE_MS);
  app.quit();
}

function requestQuitFor(signal: ElectronHostSignal): void {
  if (quitDecision(HOST_MODE, signal) === "request-quit") requestQuit();
}

function emitReadinessSignal(): void {
  console.log(`MISH_ELECTRON_READY stage=renderer-ready mode=${HOST_MODE}`);
}

function emitFailureSignal(): void {
  console.log("MISH_ELECTRON_FAILURE stage=admission");
}

process.once("SIGTERM", () => requestQuitFor("user-close"));

function failAdmission(stageName: string): void {
  if (rendererReady || failureReported) return;
  failureReported = true;
  clearRendererReadyDeadline();
  record("renderer.bootstrap", "result", "rejected");
  diagnostic(`phase=${stageName} stage=${stage}`);
  emitFailureSignal();
  requestQuitFor(stageName === "renderer-ready" ? "renderer-timeout" : "renderer-failure");
}

function isRendererStoreReport(value: unknown): value is RendererStoreReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (report.kind === "store-mounted" || report.kind === "store-cleaned") {
    return report.label === "first" || report.label === "remount";
  }
  if (report.kind === "store-notified" || report.kind === "store-batched") {
    return (
      typeof report.count === "number" &&
      Number.isSafeInteger(report.count) &&
      report.count >= 0 &&
      report.count <= 256
    );
  }
  return false;
}

function isRendererFailureReport(value: unknown): value is RendererFailureReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return (
    report.message === "admission-failed" &&
    (report.stage === "port" ||
      report.stage === "handshake" ||
      report.stage === "invoke" ||
      report.stage === "events" ||
      report.stage === "renderer")
  );
}

function isRendererReadyReport(value: unknown): value is RendererReadyReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const session = report.session;
  const store = report.store;
  const product = report.product;
  if (
    typeof session !== "object" ||
    session === null ||
    typeof store !== "object" ||
    store === null ||
    typeof product !== "object" ||
    product === null
  ) {
    return false;
  }
  const sessionRecord = session as Record<string, unknown>;
  const storeRecord = store as Record<string, unknown>;
  const productRecord = product as Record<string, unknown>;
  const routes = productRecord.routes;
  if (typeof routes !== "object" || routes === null || Array.isArray(routes)) return false;
  const routeRecord = routes as Record<string, unknown>;
  const expectedRoutes = ["status", "routes", "profiles", "traffic", "events", "settings"];
  if (
    Object.keys(routeRecord).some((key) => !expectedRoutes.includes(key)) ||
    expectedRoutes.some((key) => routeRecord[key] !== true)
  ) {
    return false;
  }
  return (
    sessionRecord.connected === true &&
    ["generation", "parentEpoch", "revision"].every(
      (key) =>
        typeof sessionRecord[key] === "number" &&
        Number.isSafeInteger(sessionRecord[key]) &&
        (sessionRecord[key] as number) > 0,
    ) &&
    typeof report.events === "number" &&
    Number.isSafeInteger(report.events) &&
    report.events > 0 &&
    storeRecord.remounted === true &&
    typeof storeRecord.notifications === "number" &&
    Number.isSafeInteger(storeRecord.notifications) &&
    storeRecord.notifications > 0 &&
    typeof storeRecord.cleanups === "number" &&
    Number.isSafeInteger(storeRecord.cleanups) &&
    storeRecord.cleanups > 0 &&
    report.strictMode === true &&
    productRecord.visible === true &&
    productRecord.statusSurface === true &&
    productRecord.placeholderVisible === false
  );
}

function recordRendererReport(event: IpcMainEvent, value: unknown): void {
  if (event.sender !== mainWindow?.webContents || metrics.reportCount >= 128) return;
  metrics.reportCount += 1;
  if (isRendererStoreReport(value)) {
    record(
      "renderer.store",
      value.kind === "store-cleaned" ? "cleanup" : "event",
      value.kind === "store-cleaned" ? "cleaned-up" : "event",
    );
  }
}

function handleRendererFailure(event: IpcMainEvent, value: unknown): void {
  if (event.sender !== mainWindow?.webContents || rendererReady || failureReported) return;
  if (!isRendererFailureReport(value)) return;
  failureReported = true;
  clearRendererReadyDeadline();
  record("renderer.bootstrap", "result", "rejected");
  diagnostic(`phase=renderer-failure stage=${value.stage}`);
  emitFailureSignal();
  requestQuitFor("renderer-failure");
}

function handleRendererReady(event: IpcMainEvent, value: unknown): void {
  if (event.sender !== mainWindow?.webContents || rendererReady || !isRendererReadyReport(value)) {
    event.reply(ELECTRON_READY_CHANNEL, "keep-session" satisfies RendererReadyDisposition);
    return;
  }
  clearRendererReadyDeadline();
  rendererReady = true;
  rendererDisposed = false;
  stage = "renderer-ready";
  record("renderer.product", "result", "ready");
  record("renderer.bootstrap", "event", "ready");
  emitReadinessSignal();
  const disposition =
    quitDecision(HOST_MODE, "renderer-ready") === "request-quit"
      ? ("dispose-and-quit" satisfies RendererReadyDisposition)
      : ("keep-session" satisfies RendererReadyDisposition);
  console.log(`MISH_ELECTRON_READY_DISPOSITION ${disposition}`);
  event.reply(ELECTRON_READY_CHANNEL, disposition);
}

function handleRendererDisposed(event: IpcMainEvent): void {
  if (
    event.sender !== mainWindow?.webContents ||
    HOST_MODE !== "fixture-auto-quit" ||
    !rendererReady ||
    rendererDisposed
  ) {
    return;
  }
  rendererDisposed = true;
  console.log("MISH_ELECTRON_DISPOSED_ACK");
  record("renderer.bootstrap", "cleanup", "cleaned-up");
  requestQuitFor("renderer-ready");
}

function postSessionPort(): void {
  if (!mainWindow || !sessionState || quitRequested) return;
  const channel = new MessageChannelMain();
  const generation = sessionState.generation + 1;
  sessionState.generation = generation;
  sessionState.parentEpoch = generation;
  sessionState.revision = generation;
  sessionState.projection.setSession({
    generation,
    parentEpoch: sessionState.parentEpoch,
    revision: sessionState.revision,
  });
  sessionState.activePort?.close();
  sessionState.activePort = channel.port1;
  ports.add(channel.port1);
  channel.port1.start();
  new MessagePortRPCHandler(createHostRouter(sessionState)).upgrade(channel.port1);
  const envelope: PortEnvelope = {
    authToken: sessionState.authToken,
    generation,
    parentEpoch: sessionState.parentEpoch,
    revision: sessionState.revision,
  };
  mainWindow.webContents.postMessage(ELECTRON_PORT_CHANNEL, envelope, [channel.port2]);
  metrics.portCount += 1;
  stage = "port-sent";
  record("renderer.bootstrap", "result", "ready");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    show: true,
    width: 880,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: fileURLToPath(new URL("./preload.mjs", import.meta.url)),
      sandbox: true,
      devTools: false,
    },
  });
  stage = "window-created";
  window.webContents.on("preload-error", (_event, _preloadPath, error) => {
    diagnostic(`phase=preload-error stage=window error=${error.message}`);
  });
  window.webContents.on("render-process-gone", () => failAdmission("render-process-gone"));
  window.webContents.once("did-finish-load", () => {
    postSessionPort();
    rendererReadyDeadline = setTimeout(
      () => failAdmission("renderer-ready"),
      RENDERER_READY_DEADLINE_MS,
    );
  });
  window.loadFile(fileURLToPath(new URL("./index.html", import.meta.url))).catch(() => {
    failAdmission("document-load");
  });
  return window;
}

function handlePortRequest(event: IpcMainEvent): void {
  if (event.sender !== mainWindow?.webContents || quitRequested) return;
  postSessionPort();
}

ipcMain.on(ELECTRON_PORT_REQUEST_CHANNEL, handlePortRequest);
ipcMain.on(ELECTRON_REPORT_CHANNEL, recordRendererReport);
ipcMain.on(ELECTRON_FAILURE_CHANNEL, handleRendererFailure);
ipcMain.on(ELECTRON_READY_CHANNEL, handleRendererReady);
ipcMain.on(ELECTRON_DISPOSED_CHANNEL, handleRendererDisposed);

app.on("before-quit", () => {
  clearRendererReadyDeadline();
  stage = "quitting";
  closePorts();
  record("application.quit", "cleanup", "cleaned-up");
});

app.on("will-quit", () => {
  clearRendererReadyDeadline();
  clearQuitDeadline();
  stage = "quit";
  record("application.quit", "result", quitRequested ? "quit" : "rejected");
  const replay = replayElectronTranscript(transcript.snapshot());
  console.log(
    `MISH_ELECTRON_TRANSCRIPT ${JSON.stringify({
      transcript: replay.events,
      logicalTime: replay.logicalTime,
      metrics,
      security: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
      stage,
    })}`,
  );
});

app.on("window-all-closed", requestQuit);
app.on("activate", () => {
  if (!mainWindow) mainWindow = createWindow();
});

void app
  .whenReady()
  .then(() => {
    const authToken = randomBytes(32).toString("base64url");
    sessionState = {
      authToken,
      projection: createElectronProjectionAuthority(),
      transcript,
      metrics,
      generation: 0,
      parentEpoch: 0,
      revision: 0,
    };
    record("window.create", "invocation", "accepted");
    mainWindow = createWindow();
    return undefined;
  })
  .catch(() => {
    failAdmission("window-create");
  });
