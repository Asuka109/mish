import {
  app,
  BrowserWindow,
  MessageChannelMain,
  ipcMain,
  type IpcMainEvent,
  type MessagePortMain,
} from "electron";
import { implement } from "@orpc/server";
import { RPCHandler as MessagePortRPCHandler } from "@orpc/server/message-port";
import { orpcContract, type EventValue, type InvokeOutput } from "@mish/poc-orpc";

import {
  ADMISSION_IPC_CHANNEL,
  FAILURE_IPC_CHANNEL,
  READY_IPC_CHANNEL,
  REPORT_IPC_CHANNEL,
  type RendererFailureReport,
  type RendererReadyReport,
  type StoreReport,
} from "./electron-api.ts";
import { correlation, ElectronTranscript } from "./transcript.ts";

const FIXTURE_AUTH_TOKEN = "fixture-token";
const FIXTURE_PROTOCOL_VERSION = 1;
const FIXTURE_SESSION_GENERATION = 1;
const FIXTURE_MAX_MESSAGE_BYTES = 4096;

interface FixtureMetrics {
  activeStreams: number;
  cleanupCount: number;
}

type FixtureStage =
  | "starting"
  | "window-created"
  | "port-sent"
  | "renderer-store"
  | "renderer-ready"
  | "quit-requested"
  | "quitting"
  | "quit";

const RENDERER_READY_DEADLINE_MS = 10_000;
const QUIT_DEADLINE_MS = 5_000;

let mainWindow: BrowserWindow | undefined;
let mainPort: MessagePortMain | undefined;
let ready = false;
let reportCount = 0;
let failureReported = false;
let quitRequested = false;
let stage: FixtureStage = "starting";
let rendererReadyDeadline: ReturnType<typeof setTimeout> | undefined;
let quitDeadline: ReturnType<typeof setTimeout> | undefined;
const transcript = new ElectronTranscript(128);
const metrics: FixtureMetrics = { activeStreams: 0, cleanupCount: 0 };

function diagnostic(message: string): void {
  console.error(`MISH_ELECTRON_DIAGNOSTIC ${message}`);
}

diagnostic("phase=main-loaded stage=starting");

function record(
  operation: Parameters<ElectronTranscript["record"]>[0]["operation"],
  effect: Parameters<ElectronTranscript["record"]>[0]["effect"],
  result: Parameters<ElectronTranscript["record"]>[0]["result"],
  index = transcript.snapshot().length + 1,
): void {
  transcript.record({ operation, effect, result, correlationId: correlation(index) });
}

function isStoreReport(value: unknown): value is StoreReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  if (report.kind === "store-mounted" || report.kind === "store-cleaned") {
    return report.label === "first" || report.label === "remount";
  }
  if (report.kind === "store-notified" || report.kind === "store-batched") {
    return (
      typeof report.count === "number" && Number.isSafeInteger(report.count) && report.count >= 0
    );
  }
  return false;
}

function isRendererReadyReport(value: unknown): value is RendererReadyReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  const store = report.store;
  if (!store || typeof store !== "object") return false;
  const storeReport = store as Record<string, unknown>;
  return (
    report.orpc !== undefined &&
    storeReport.remounted === true &&
    typeof storeReport.notifications === "number" &&
    Number.isSafeInteger(storeReport.notifications) &&
    storeReport.notifications > 0 &&
    typeof storeReport.cleanups === "number" &&
    Number.isSafeInteger(storeReport.cleanups) &&
    storeReport.cleanups > 0
  );
}

function isRendererFailureReport(value: unknown): value is RendererFailureReport {
  if (!value || typeof value !== "object") return false;
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

function clearRendererReadyDeadline(): void {
  if (rendererReadyDeadline) {
    clearTimeout(rendererReadyDeadline);
    rendererReadyDeadline = undefined;
  }
}

function clearQuitDeadline(): void {
  if (quitDeadline) {
    clearTimeout(quitDeadline);
    quitDeadline = undefined;
  }
}

function requestQuit(): void {
  if (quitRequested) return;
  quitRequested = true;
  stage = "quit-requested";
  diagnostic(`phase=quit-request stage=${stage}`);
  record("application.quit", "invocation", "accepted");
  quitDeadline = setTimeout(() => {
    console.error(`MISH_ELECTRON_DEADLINE phase=quit stage=${stage}`);
    app.exit(1);
  }, QUIT_DEADLINE_MS);
  app.quit();
}

function failAdmission(phase: string): void {
  if (ready || failureReported) return;
  failureReported = true;
  clearRendererReadyDeadline();
  record("renderer.bootstrap", "result", "rejected");
  console.error(`MISH_ELECTRON_DEADLINE phase=${phase} stage=${stage}`);
  requestQuit();
}

function recordRendererReport(event: IpcMainEvent, value: unknown): void {
  if (event.sender !== mainWindow?.webContents || ++reportCount > 64) {
    return;
  }
  if (isStoreReport(value)) {
    if (stage !== "renderer-ready" && stage !== "quit-requested") stage = "renderer-store";
    record("renderer.store", "event", value.kind === "store-cleaned" ? "cleaned-up" : "event");
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "orpc-transcript"
  ) {
    const events = (value as { readonly events?: unknown }).events;
    if (Array.isArray(events) && events.length <= 64) {
      record("orpc.events", "event", "event");
    }
  }
}

function handleRendererFailure(event: IpcMainEvent, value: unknown): void {
  if (event.sender !== mainWindow?.webContents || ready || failureReported) return;
  if (!isRendererFailureReport(value)) return;
  failureReported = true;
  clearRendererReadyDeadline();
  record("renderer.bootstrap", "result", "rejected");
  console.error(`MISH_ELECTRON_DIAGNOSTIC renderer-failure stage=${value.stage}`);
  requestQuit();
}

function createFixtureRouter() {
  const implementation = implement(orpcContract);
  return implementation.router({
    session: {
      handshake: implementation.session.handshake.handler(({ input }) => {
        if (input.authToken !== FIXTURE_AUTH_TOKEN) {
          throw new Error("fixture authentication rejected");
        }
        if (input.protocolVersion !== FIXTURE_PROTOCOL_VERSION) {
          throw new Error("fixture protocol version rejected");
        }
        record("orpc.handshake", "result", "accepted");
        return {
          maxMessageBytes: FIXTURE_MAX_MESSAGE_BYTES,
          protocolVersion: FIXTURE_PROTOCOL_VERSION,
          sessionGeneration: FIXTURE_SESSION_GENERATION,
        };
      }),
    },
    invoke: implementation.invoke.handler(({ input }) => {
      const output: InvokeOutput = {
        correlationId: input.correlationId,
        operation: input.operation,
        sessionGeneration: input.sessionGeneration,
        value: "ok",
      };
      record("orpc.invoke", "result", "accepted");
      return output;
    }),
    events: {
      watch: implementation.events.watch.handler(async function* ({ input }) {
        metrics.activeStreams += 1;
        try {
          const values: readonly EventValue[] = [
            {
              correlationId: input.correlationId,
              sequence: 1,
              sessionGeneration: input.sessionGeneration,
              value: "ready",
            },
            {
              correlationId: input.correlationId,
              sequence: 2,
              sessionGeneration: input.sessionGeneration,
              value: "changed",
            },
          ];
          for (const value of values) {
            record("orpc.events", "event", "event");
            yield value;
          }
          return {
            correlationId: input.correlationId,
            sessionGeneration: input.sessionGeneration,
            value: "closed" as const,
          };
        } finally {
          metrics.activeStreams -= 1;
          metrics.cleanupCount += 1;
          record("orpc.events", "cleanup", "cleaned-up");
        }
      }),
    },
  });
}

function sendPortToRenderer(): void {
  if (!mainWindow || mainPort) return;
  try {
    const channel = new MessageChannelMain();
    mainPort = channel.port1;
    new MessagePortRPCHandler(createFixtureRouter()).upgrade(channel.port1);
    channel.port1.start();
    mainWindow.webContents.postMessage(ADMISSION_IPC_CHANNEL, null, [channel.port2]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostic(`phase=port-send stage=${stage} error=${message}`);
    failAdmission("port-send");
    return;
  }
  stage = "port-sent";
  diagnostic(`phase=port-sent stage=${stage}`);
  record("renderer.bootstrap", "result", "ready");
  rendererReadyDeadline = setTimeout(
    () => failAdmission("renderer-ready"),
    RENDERER_READY_DEADLINE_MS,
  );
}

function handleRendererReady(event: IpcMainEvent, value: unknown): void {
  if (event.sender !== mainWindow?.webContents || ready || !isRendererReadyReport(value)) {
    return;
  }
  clearRendererReadyDeadline();
  ready = true;
  stage = "renderer-ready";
  diagnostic(`phase=renderer-ready stage=${stage}`);
  record("renderer.bootstrap", "event", "ready");
  setImmediate(requestQuit);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 420,
    webPreferences: {
      preload: new URL("./preload.mjs", import.meta.url).pathname,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  stage = "window-created";
  diagnostic(`phase=window-created stage=${stage}`);
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`MISH_ELECTRON_DIAGNOSTIC preload-error ${preloadPath}: ${error.message}`);
  });
  window.webContents.on("console-message", (details) => {
    console.error(
      `MISH_ELECTRON_DIAGNOSTIC console-${details.level} ${details.sourceId}:${details.lineNumber}: ${details.message}`,
    );
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(
      `MISH_ELECTRON_DIAGNOSTIC did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`,
    );
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`MISH_ELECTRON_DIAGNOSTIC render-process-gone ${details.reason}`);
  });
  window.webContents.once("did-finish-load", sendPortToRenderer);
  window.loadFile(new URL("./index.html", import.meta.url).pathname).catch(() => {
    failAdmission("document-load");
  });
  return window;
}

ipcMain.on(REPORT_IPC_CHANNEL, recordRendererReport);
ipcMain.on(FAILURE_IPC_CHANNEL, handleRendererFailure);
ipcMain.on(READY_IPC_CHANNEL, handleRendererReady);

app.on("before-quit", () => {
  clearRendererReadyDeadline();
  stage = "quitting";
  mainPort?.close();
  mainPort = undefined;
  record("application.quit", "cleanup", "cleaned-up");
});

app.on("will-quit", () => {
  clearRendererReadyDeadline();
  clearQuitDeadline();
  stage = "quit";
  if (!ready) record("application.quit", "result", "rejected");
  else record("application.quit", "result", "quit");
  console.log(
    `MISH_ELECTRON_TRANSCRIPT ${JSON.stringify({
      transcript: transcript.snapshot(),
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

app.on("window-all-closed", () => {
  if (ready || failureReported) requestQuit();
});

void app
  .whenReady()
  .then(() => {
    diagnostic("phase=when-ready stage=starting");
    record("window.create", "invocation", "accepted");
    mainWindow = createWindow();
  })
  .catch(() => {
    console.error("MISH_ELECTRON_DEADLINE phase=window-create stage=starting");
    app.exit(1);
  });
