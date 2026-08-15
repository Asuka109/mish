import { contextBridge, ipcRenderer } from "electron";
import { BoundedMessagePortChannel, BoundedTranscript, PolicySession } from "@mish/poc-orpc";
import type { EventValue, HandshakeOutput, InvokeOutput } from "@mish/poc-orpc";

import {
  ADMISSION_IPC_CHANNEL,
  FAILURE_IPC_CHANNEL,
  READY_IPC_CHANNEL,
  REPORT_IPC_CHANNEL,
  type ElectronAdmissionApi,
  type OrpcAdmissionResult,
  type RendererFailureStage,
  type RendererFailureReport,
  type RendererReadyReport,
  type StoreReport,
} from "./electron-api.ts";

let portReadyResolve: ((port: MessagePort) => void) | undefined;
const portReady = new Promise<MessagePort>((resolve) => {
  portReadyResolve = resolve;
});

let session: PolicySession | undefined;
let handshake: HandshakeOutput | undefined;
let failureStage: RendererFailureStage = "port";

ipcRenderer.on(ADMISSION_IPC_CHANNEL, (event) => {
  const port = event.ports[0];
  if (!port || !portReadyResolve) return;
  port.start();
  portReadyResolve(port);
  portReadyResolve = undefined;
});

async function ensureSession(): Promise<{ session: PolicySession; handshake: HandshakeOutput }> {
  if (session && handshake) return { session, handshake };
  const port = await waitForPort();
  failureStage = "handshake";
  const transcript = new BoundedTranscript({ transport: "message-port", maxEvents: 64 });
  const nextSession = new PolicySession({
    authToken: "fixture-token",
    clientName: "electron",
    clientVersion: "43.4.0-fixture",
    protocolVersion: 1,
    maxMessageBytes: 16 * 1024,
    maxDeadlineMs: 1000,
    transcript,
  });
  const nextHandshake = await nextSession.connect(new BoundedMessagePortChannel(port, 16 * 1024));
  session = nextSession;
  handshake = nextHandshake;
  return { session: nextSession, handshake: nextHandshake };
}

async function waitForPort(): Promise<MessagePort> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      portReady,
      new Promise<MessagePort>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("message-port deadline")), 8_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runOrpcAdmission(): Promise<OrpcAdmissionResult> {
  try {
    const current = await ensureSession();
    failureStage = "invoke";
    const invocation: InvokeOutput = await current.session.invoke("status.snapshot", {
      deadlineMs: 250,
    });
    failureStage = "events";
    const iterator = await current.session.watchEvents();
    const events: EventValue[] = [];
    const first = await iterator.next();
    if (!first.done) events.push(first.value);
    const second = await iterator.next();
    if (!second.done) events.push(second.value);
    await iterator.return?.();
    const result: OrpcAdmissionResult = {
      handshake: current.handshake,
      invocation,
      events,
      cleanup: "iterator-returned",
    };
    current.session.dispose();
    return result;
  } catch (error) {
    ipcRenderer.send(FAILURE_IPC_CHANNEL, {
      stage: failureStage,
      message: "admission-failed",
    } satisfies RendererFailureReport);
    throw error;
  }
}

const api: ElectronAdmissionApi = {
  runOrpcAdmission,
  reportStore(report: StoreReport): void {
    ipcRenderer.send(REPORT_IPC_CHANNEL, report);
  },
  reportFailure(report: RendererFailureReport): void {
    ipcRenderer.send(FAILURE_IPC_CHANNEL, report);
  },
  rendererReady(report: RendererReadyReport): void {
    ipcRenderer.send(READY_IPC_CHANNEL, report);
  },
};

contextBridge.exposeInMainWorld("mishElectron", api);
