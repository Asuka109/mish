import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

type JsonObject = Record<string, any>;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const acceptanceRoot = path.join(repositoryRoot, ".scratch", "tart-tun-acceptance");
const desktopLog = path.join(acceptanceRoot, "desktop.log");
const rpcReceipt = path.join(acceptanceRoot, "rpc.json");
const fictionalProfileFileName = "fictional-tart.yaml";
const publicHttpUrl = "http://example.com/";
const observableHttpUrl = "http://httpbin.org/delay/10";

function requireAcceptanceBoundary() {
  if (process.platform !== "darwin" || process.env.MISH_TART_TUN_ACCEPTANCE !== "1") {
    throw new Error("The Tart TUN RPC harness requires its exact macOS acceptance boundary");
  }
}

async function bootstrap() {
  const log = await readFile(desktopLog, "utf8");
  if (Buffer.byteLength(log) > 1_048_576) {
    throw new Error("The desktop acceptance log exceeded its bounded size");
  }
  const matches = [
    ...log.matchAll(
      /Mish Browser Client URL: (http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43})/gu,
    ),
  ];
  const nativeOriginMatches = [
    ...log.matchAll(/Mish desktop development origin: (http:\/\/127\.0\.0\.1:\d+)/gu),
  ];
  const launchUrl = matches.at(-1)?.[1];
  const nativeOrigin = nativeOriginMatches.at(-1)?.[1];
  if (!launchUrl) throw new Error("The desktop acceptance launch URL is unavailable");
  if (!nativeOrigin) throw new Error("The desktop acceptance native origin is unavailable");
  const parsed = new URL(launchUrl);
  const launchToken = parsed.hash.replace("#token=", "");
  const origin = parsed.origin;
  const response = await fetch(`${origin}/browser-bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Mish-Browser-Launch ${launchToken}`,
      Origin: origin,
      "X-Mish-Browser-Proof": randomBytes(32).toString("hex"),
    },
  });
  if (!response.ok) throw new Error(`Browser bootstrap failed with HTTP ${response.status}`);
  const payload = (await response.json()) as JsonObject;
  if (
    typeof payload.authToken !== "string" ||
    payload.authToken.length < 32 ||
    typeof payload.rpcUrl !== "string" ||
    !/^ws:\/\/127\.0\.0\.1:\d+\/rpc$/u.test(payload.rpcUrl)
  ) {
    throw new Error("Browser bootstrap returned an invalid local RPC boundary");
  }
  await mkdir(acceptanceRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    rpcReceipt,
    `${JSON.stringify({ authToken: payload.authToken, nativeOrigin, rpcUrl: payload.rpcUrl })}\n`,
    { mode: 0o600 },
  );
  await chmod(rpcReceipt, 0o600);
  return { bootstrapped: true };
}

class RpcConnection {
  private nextId = 1;
  private readonly notifications = new Set<(message: JsonObject) => void>();
  private readonly pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: any) => void }
  >();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as JsonObject;
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          const kind =
            typeof message.error.data?.kind === "string" ? ` (${message.error.data.kind})` : "";
          pending.reject(new Error(`${String(message.error.message ?? "RPC failed")}${kind}`));
        } else pending.resolve(message.result);
        return;
      }
      for (const listener of this.notifications) listener(message);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("The desktop RPC connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect() {
    const receipt = JSON.parse(await readFile(rpcReceipt, "utf8")) as JsonObject;
    if (
      typeof receipt.authToken !== "string" ||
      receipt.authToken.length < 32 ||
      typeof receipt.nativeOrigin !== "string" ||
      !/^http:\/\/127\.0\.0\.1:\d+$/u.test(receipt.nativeOrigin) ||
      typeof receipt.rpcUrl !== "string" ||
      !/^ws:\/\/127\.0\.0\.1:\d+\/rpc$/u.test(receipt.rpcUrl)
    ) {
      throw new Error("The private RPC receipt is invalid");
    }
    const socket = new WebSocket(receipt.rpcUrl, {
      // The exact Tart launcher publishes this development origin and the desktop bridge
      // recognizes it as the native surface. A Browser origin must remain TUN-unavailable.
      headers: { Origin: receipt.nativeOrigin },
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Desktop RPC is unavailable")), {
        once: true,
      });
    });
    const connection = new RpcConnection(socket);
    await connection.request("rpc.authenticate", {
      clientName: "mish-tart-tun-acceptance",
      clientVersion: "1",
      token: receipt.authToken,
    });
    return connection;
  }

  close() {
    this.socket.close();
  }

  onNotification(listener: (message: JsonObject) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  request(method: string, params: JsonObject) {
    const id = this.nextId++;
    const result = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
    this.socket.send(JSON.stringify({ id, jsonrpc: "2.0", method, params }));
    return result;
  }
}

function tunComponents(snapshot: JsonObject) {
  const observation = snapshot.runtime?.tun?.observation;
  return {
    core: observation?.core ?? null,
    dns: observation?.dns ?? null,
    interface: observation?.interface ?? null,
    routes: observation?.routes ?? null,
  };
}

export function summarizeStatus(snapshot: JsonObject, phases: string[] = []) {
  const components = tunComponents(snapshot);
  const confirmed = Object.values(components).every((component) => component === "confirmed");
  const absent = [components.interface, components.routes, components.dns].every(
    (component) => component === "absent",
  );
  return {
    appliedOnlyAfterConfirmed:
      phases.includes("pending") && snapshot.runtime?.tun?.phase === "applied" && confirmed,
    captureOperation: snapshot.runtime?.captureOperation?.phase ?? null,
    components,
    corePhase: snapshot.runtime?.core?.phase ?? null,
    observedDisabled: absent,
    phases: [...new Set(phases)],
    systemProxyEnabled: snapshot.runtime?.systemProxyEnabled === true,
    tunDesired: snapshot.runtime?.tun?.desired === true,
    tunEnabled: snapshot.runtime?.tunEnabled === true,
    tunFailure: snapshot.runtime?.tun?.failure ?? null,
    tunPhase: snapshot.runtime?.tun?.phase ?? null,
  };
}

async function selectFictionalProfile(connection: RpcConnection) {
  let profiles: JsonObject | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    profiles = await connection.request("profiles.getSnapshot", {});
    if (
      profiles.profiles?.some(
        (profile: JsonObject) =>
          profile.fileName === fictionalProfileFileName && profile.status?.valid === true,
      )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const profile = profiles?.profiles?.find(
    (candidate: JsonObject) =>
      candidate.fileName === fictionalProfileFileName && candidate.status?.valid === true,
  );
  if (!profile) throw new Error("The repository-owned fictional Tart Profile is unavailable");
  if (profiles.selection?.profileId !== profile.id) {
    await connection.request("profiles.select", {
      expectedSelection: profiles.selection,
      profileId: profile.id,
    });
  }
}

async function waitForProfileOperation(
  connection: RpcConnection,
  commandId: string,
  initial: JsonObject,
  operation: string,
) {
  let activation = initial;
  for (let attempt = 0; activation.phase === "pending" && attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const current = await connection.request("profiles.getSnapshot", {});
    if (current.activation?.commandId === commandId) activation = current.activation;
  }
  if (activation.phase === "pending") {
    throw new Error(`The ordinary Core ${operation} did not reach a bounded terminal state`);
  }
  return activation;
}

async function completedPublicHttpRequest() {
  const response = await fetch(publicHttpUrl, { redirect: "manual" });
  await response.arrayBuffer();
  return response.status;
}

async function activateOrdinaryCore() {
  const connection = await RpcConnection.connect();
  try {
    await selectFictionalProfile(connection);
    const profiles = await connection.request("profiles.getSnapshot", {});
    const profile = profiles.profiles?.find(
      (candidate: JsonObject) => candidate.fileName === fictionalProfileFileName,
    );
    if (!profile) throw new Error("The repository-owned fictional Tart Profile is unavailable");
    const commandId = randomUUID();
    const pending = await connection.request("profiles.activate", {
      commandId,
      profileId: profile.id,
    });
    const activation = await waitForProfileOperation(connection, commandId, pending, "activation");
    const status = await connection.request("status.getSnapshot", {});
    return {
      activationFailure: activation.failure ?? null,
      activationPhase: activation.phase ?? null,
      activationSafeStopped: activation.safeStopped ?? null,
      corePhase: status.runtime?.core?.phase ?? null,
      profile: "repository-fictional",
      systemProxyEnabled: status.runtime?.systemProxyEnabled === true,
      tunDesired: status.runtime?.tun?.desired === true,
      tunPhase: status.runtime?.tun?.phase ?? null,
    };
  } finally {
    connection.close();
  }
}

async function stopCore() {
  const connection = await RpcConnection.connect();
  try {
    const commandId = randomUUID();
    const pending = await connection.request("profiles.stop", { commandId });
    const activation = await waitForProfileOperation(connection, commandId, pending, "stop");
    const status = await connection.request("status.getSnapshot", {});
    return {
      activationFailure: activation.failure ?? null,
      activationPhase: activation.phase ?? null,
      activationSafeStopped: activation.safeStopped ?? null,
      corePhase: status.runtime?.core?.phase ?? null,
      systemProxyEnabled: status.runtime?.systemProxyEnabled === true,
      tunDesired: status.runtime?.tun?.desired === true,
      tunPhase: status.runtime?.tun?.phase ?? null,
    };
  } finally {
    connection.close();
  }
}

function startObservableHttpRequest() {
  const request = get(observableHttpUrl);
  request.on("response", (response) => response.pause());
  request.on("error", () => {
    // The acceptance intentionally aborts this delayed request after Traffic observes it.
  });
  return request;
}

async function enable() {
  const connection = await RpcConnection.connect();
  const phases: string[] = [];
  const statusUpdates: JsonObject[] = [];
  const unsubscribe = connection.onNotification((message) => {
    if (message.method !== "status.snapshot") return;
    statusUpdates.push(message.params?.snapshot ?? {});
    const phase = message.params?.snapshot?.runtime?.tun?.phase;
    if (typeof phase === "string") phases.push(phase);
  });
  try {
    await selectFictionalProfile(connection);
    const subscription = await connection.request("status.subscribe", {});
    const initialPhase = subscription.snapshot?.runtime?.tun?.phase;
    if (typeof initialPhase === "string") phases.push(initialPhase);
    let applied: JsonObject;
    try {
      applied = await connection.request("status.setCapture", {
        active: true,
        selection: { systemProxy: false, tun: true },
      });
    } catch (error) {
      const current = await connection.request("status.getSnapshot", {});
      const observedFailure = [...statusUpdates]
        .reverse()
        .find((update) => update.runtime?.tun?.failure !== null);
      const observationSequence = statusUpdates
        .map((update) => {
          const summary = summarizeStatus(update);
          return {
            components: summary.components,
            failure: summary.tunFailure,
            phase: summary.tunPhase,
          };
        })
        .filter(
          (entry, index, entries) =>
            index === 0 || JSON.stringify(entry) !== JSON.stringify(entries[index - 1]),
        )
        .slice(-12);
      return {
        ...summarizeStatus(current, phases),
        activationFailed: true,
        failureKind: error instanceof Error ? error.message.match(/\(([^)]+)\)$/u)?.[1] : null,
        failedObservation: observedFailure
          ? summarizeStatus(observedFailure, phases).components
          : null,
        failedTunFailure: observedFailure?.runtime?.tun?.failure ?? null,
        observationSequence,
        profile: "repository-fictional",
      };
    }
    const trafficBefore = await connection.request("traffic.getSnapshot", {});
    const priorIds = new Set(
      (trafficBefore.activeConnections ?? []).map((item: JsonObject) => item.id),
    );
    const publicHttpStatus = await completedPublicHttpRequest();
    const observableRequest = startObservableHttpRequest();
    let trafficObserved = false;
    let trafficPhase: string | null = null;
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const traffic = await connection.request("traffic.getSnapshot", {});
        trafficPhase = traffic.phase ?? null;
        trafficObserved = (traffic.activeConnections ?? []).some(
          (item: JsonObject) =>
            !priorIds.has(item.id) &&
            item.destinationPort === 80 &&
            [item.destinationHost, item.sniffHost].some((host) =>
              ["example.com", "httpbin.org"].includes(host),
            ),
        );
        if (trafficObserved) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      observableRequest.destroy();
    }
    return {
      ...summarizeStatus(applied, phases),
      profile: "repository-fictional",
      publicHttpCompleted: publicHttpStatus >= 200 && publicHttpStatus < 400,
      publicHttpStatus,
      trafficObserved,
      trafficPhase,
    };
  } finally {
    unsubscribe();
    connection.close();
  }
}

async function snapshot() {
  const connection = await RpcConnection.connect();
  try {
    const [status, profiles] = await Promise.all([
      connection.request("status.getSnapshot", {}),
      connection.request("profiles.getSnapshot", {}),
    ]);
    return {
      ...summarizeStatus(status),
      activationFailure: profiles.activation?.failure ?? null,
      activationPhase: profiles.activation?.phase ?? null,
      activationSafeStopped: profiles.activation?.safeStopped ?? null,
    };
  } finally {
    connection.close();
  }
}

async function disable() {
  const connection = await RpcConnection.connect();
  try {
    const current = await connection.request("status.getSnapshot", {});
    const disabled = await connection.request("status.setCapture", {
      active: false,
      selection: current.runtime.captureSelection,
    });
    return summarizeStatus(disabled);
  } finally {
    connection.close();
  }
}

async function main() {
  requireAcceptanceBoundary();
  const action = process.argv[2];
  const result =
    action === "bootstrap"
      ? await bootstrap()
      : action === "activate-core"
        ? await activateOrdinaryCore()
        : action === "stop-core"
          ? await stopCore()
          : action === "enable"
            ? await enable()
            : action === "snapshot"
              ? await snapshot()
              : action === "disable"
                ? await disable()
                : undefined;
  if (!result) {
    throw new Error(
      "Usage: node scripts/macos-tart-tun-rpc.ts <bootstrap|activate-core|enable|snapshot|disable|stop-core>",
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  await main();
}
