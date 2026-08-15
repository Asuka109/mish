import { contextBridge, ipcRenderer } from "./electron-sandbox.js";
import type { IpcRendererEvent } from "electron";
import {
  BoundedTranscript,
  MessagePortTransport,
  OrpcSessionAuthority,
  OrpcSessionError,
  type OrpcSessionState,
} from "@mish/orpc-client";
import type {
  OrpcEventValue,
  OrpcHandshakeOutput,
  OrpcInvokeOutput,
  OrpcOperation,
} from "@mish/contracts";

import {
  ELECTRON_FAILURE_CHANNEL,
  ELECTRON_PORT_CHANNEL,
  ELECTRON_PORT_REQUEST_CHANNEL,
  ELECTRON_READY_CHANNEL,
  ELECTRON_REPORT_CHANNEL,
  type ElectronEventClosedListener,
  type ElectronEventListener,
  type ElectronHostApi,
  type ElectronSessionMetadata,
  type RendererFailureReport,
  type RendererReadyReport,
  type RendererStoreReport,
} from "./electron-api.js";

interface SessionPortEnvelope {
  readonly authToken: string;
}

interface PendingPort {
  readonly port: MessagePort;
  readonly authToken: string;
}

const PORT_WAIT_DEADLINE_MS = 8_000;
const MAX_PENDING_PORTS = 4;

const pendingPorts: PendingPort[] = [];
const pendingPortWaiters: Array<(port: PendingPort) => void> = [];
let authority: OrpcSessionAuthority | undefined;
let connectPromise: Promise<OrpcHandshakeOutput> | undefined;
let sessionToken: string | undefined;
let activeIterator: AsyncIterableIterator<OrpcEventValue> | undefined;
let activeStreamController: AbortController | undefined;
let activeStreamTask: Promise<void> | undefined;
let failureStage: RendererFailureReport["stage"] = "port";

function isSessionPortEnvelope(value: unknown): value is SessionPortEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly authToken?: unknown }).authToken === "string" &&
    (value as { readonly authToken: string }).authToken.length > 0
  );
}

function enqueuePort(event: IpcRendererEvent, value: unknown): void {
  const port = event.ports[0];
  if (!port || !isSessionPortEnvelope(value)) {
    port?.close();
    return;
  }
  const pending: PendingPort = { authToken: value.authToken, port };
  port.start();
  const waiter = pendingPortWaiters.shift();
  if (waiter) {
    waiter(pending);
    return;
  }
  if (pendingPorts.length >= MAX_PENDING_PORTS) {
    pending.port.close();
    return;
  }
  pendingPorts.push(pending);
}

ipcRenderer.on(ELECTRON_PORT_CHANNEL, enqueuePort);

function waitForPort(): Promise<PendingPort> {
  const current = pendingPorts.shift();
  if (current) return Promise.resolve(current);
  return new Promise<PendingPort>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let waiter: ((port: PendingPort) => void) | undefined;
    const finish = (error: Error | undefined, value?: PendingPort): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (waiter) {
        const index = pendingPortWaiters.indexOf(waiter);
        if (index >= 0) pendingPortWaiters.splice(index, 1);
      }
      if (error) reject(error);
      else if (value) resolve(value);
    };
    waiter = (value) => finish(undefined, value);
    pendingPortWaiters.push(waiter);
    timer = setTimeout(
      () => finish(new Error("Electron session port deadline")),
      PORT_WAIT_DEADLINE_MS,
    );
  });
}

function metadata(): ElectronSessionMetadata {
  return {
    state: (authority?.state ?? "disconnected") as OrpcSessionState,
    sessionGeneration: authority?.sessionGeneration ?? 0,
    parentEpoch: authority?.parentEpoch ?? 0,
    revision: authority?.revision ?? 0,
  };
}

async function connect(): Promise<OrpcHandshakeOutput> {
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    if (authority?.state === "disposed") throw new OrpcSessionError("disposed");
    const reconnect = authority !== undefined;
    if (reconnect) {
      failureStage = "port";
      ipcRenderer.send(ELECTRON_PORT_REQUEST_CHANNEL);
    }
    const pending = await waitForPort();
    sessionToken = pending.authToken;
    const transport = new MessagePortTransport(pending.port, 16 * 1024);
    if (!authority) {
      failureStage = "handshake";
      authority = new OrpcSessionAuthority({
        authToken: sessionToken,
        clientName: "electron",
        clientVersion: "desktop-electron-43.4.0",
        maxDeadlineMs: 1_000,
        maxMessageBytes: 16 * 1024,
        transcript: new BoundedTranscript({ maxEvents: 128, sessionId: "orpc-session-0001" }),
      });
      return authority.connect(transport, { deadlineMs: 500 });
    }
    failureStage = "handshake";
    return authority.reconnect(transport, { deadlineMs: 500 });
  })().catch((error: unknown) => {
    const report: RendererFailureReport = { stage: failureStage, message: "admission-failed" };
    ipcRenderer.send(ELECTRON_FAILURE_CHANNEL, report);
    throw error;
  });
  try {
    return await connectPromise;
  } finally {
    connectPromise = undefined;
  }
}

function invoke(operation: OrpcOperation, deadlineMs = 250): Promise<OrpcInvokeOutput> {
  if (!authority) return Promise.reject(new OrpcSessionError("not-connected"));
  failureStage = "invoke";
  return authority.invoke(operation, { deadlineMs });
}

async function watchEvents(
  onEvent: ElectronEventListener,
  onClosed: ElectronEventClosedListener,
): Promise<void> {
  if (activeStreamTask) return;
  if (!authority) throw new OrpcSessionError("not-connected");
  failureStage = "events";
  const controller = new AbortController();
  activeStreamController = controller;
  const iterator = await authority.watchEvents({ signal: controller.signal });
  activeIterator = iterator;
  const task = (async () => {
    try {
      while (!controller.signal.aborted) {
        // The iterator is intentionally drained one chunk at a time so its
        // bounded cleanup authority remains observable.
        // oxlint-disable-next-line no-await-in-loop
        const result = await iterator.next();
        if (result.done) {
          if (!controller.signal.aborted) onClosed();
          break;
        }
        onEvent(result.value);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        ipcRenderer.send(ELECTRON_FAILURE_CHANNEL, {
          stage: failureStage,
          message: "admission-failed",
        } satisfies RendererFailureReport);
        throw error;
      }
    }
  })();
  activeStreamTask = task;
  void task
    .finally(() => {
      if (activeStreamTask === task) {
        activeStreamTask = undefined;
        activeIterator = undefined;
        activeStreamController = undefined;
      }
    })
    .catch(() => undefined);
}

async function stopEvents(): Promise<void> {
  const controller = activeStreamController;
  const iterator = activeIterator;
  const task = activeStreamTask;
  if (!controller && !iterator && !task) return;
  controller?.abort();
  try {
    await iterator?.return?.();
  } catch {
    // The session authority records cleanup even when its peer is already gone.
  }
  await task?.catch(() => undefined);
  activeIterator = undefined;
  activeStreamController = undefined;
  activeStreamTask = undefined;
}

function disconnect(): void {
  authority?.disconnect();
  void stopEvents();
}

async function dispose(): Promise<void> {
  await stopEvents();
  await authority?.dispose();
  authority = undefined;
  sessionToken = undefined;
  for (const pending of pendingPorts.splice(0)) pending.port.close();
}

const api: ElectronHostApi = {
  connect,
  invoke,
  watchEvents,
  stopEvents,
  disconnect,
  dispose,
  getSessionMetadata: metadata,
  reportStore(report: RendererStoreReport): void {
    ipcRenderer.send(ELECTRON_REPORT_CHANNEL, report);
  },
  reportFailure(report: RendererFailureReport): void {
    ipcRenderer.send(ELECTRON_FAILURE_CHANNEL, report);
  },
  rendererReady(report: RendererReadyReport): void {
    ipcRenderer.send(ELECTRON_READY_CHANNEL, report);
  },
};

contextBridge.exposeInMainWorld("mishElectron", api);
