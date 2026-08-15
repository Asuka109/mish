import { z } from "zod";

export const IPC_CHANNELS = Object.freeze({
  getShellInfo: "mish.shell.get-info",
  recordLifecycle: "mish.shell.record-lifecycle",
} as const);

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
export const MAX_IPC_PAYLOAD_BYTES = 4 * 1024;
export const MAX_LIFECYCLE_EVENTS = 32;

const EmptyPayloadSchema = z.object({}).strict();
const LifecyclePayloadSchema = z
  .object({ event: z.enum(["renderer-ready", "renderer-page-hidden", "renderer-destroyed"]) })
  .strict();

export const ShellInfoSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z.literal("electron"),
    backend: z.literal("unavailable"),
    capabilities: z
      .object({
        core: z.literal("unavailable"),
        helper: z.literal("unavailable"),
        systemProxy: z.literal("unavailable"),
        tun: z.literal("unavailable"),
        updater: z.literal("unavailable"),
      })
      .strict(),
  })
  .strict();

export type ShellInfo = z.infer<typeof ShellInfoSchema>;
export type LifecycleEvent = z.infer<typeof LifecyclePayloadSchema>["event"];
export type LifecycleRecord = { event: LifecycleEvent; sequence: number };

export class IpcError extends Error {
  constructor(
    readonly code:
      | "channel-not-allowed"
      | "payload-too-large"
      | "payload-invalid"
      | "sender-untrusted"
      | "lifecycle-overflow",
    message: string,
  ) {
    super(message);
    this.name = "IpcError";
  }
}

function payloadSize(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    throw new IpcError("payload-invalid", "IPC payload is not JSON serializable");
  }
}

function validatePayloadSize(payload: unknown): void {
  const size = payloadSize(payload);
  if (size > MAX_IPC_PAYLOAD_BYTES) {
    throw new IpcError("payload-too-large", "IPC payload exceeds the bounded limit");
  }
}

export class LifecycleTranscript {
  #events: LifecycleRecord[] = [];
  #nextSequence = 1;

  record(event: LifecycleEvent): LifecycleRecord {
    if (this.#events.length >= MAX_LIFECYCLE_EVENTS) {
      throw new IpcError("lifecycle-overflow", "Electron lifecycle transcript is full");
    }
    const record = { event, sequence: this.#nextSequence };
    this.#nextSequence += 1;
    this.#events.push(record);
    return record;
  }

  snapshot(): readonly LifecycleRecord[] {
    return this.#events.map((event) => ({ ...event }));
  }
}

export type IpcRequestContext = { senderTrusted: boolean };
export type IpcRouterDependencies = {
  getShellInfo(): ShellInfo;
  lifecycle: LifecycleTranscript;
};

export class IpcRouter {
  readonly #dependencies: IpcRouterDependencies;

  constructor(dependencies: IpcRouterDependencies) {
    this.#dependencies = dependencies;
  }

  invoke(channel: string, payload: unknown, context: IpcRequestContext): unknown {
    if (!(Object.values(IPC_CHANNELS) as readonly string[]).includes(channel)) {
      throw new IpcError("channel-not-allowed", "IPC channel is not allowlisted");
    }
    if (!context.senderTrusted) {
      throw new IpcError("sender-untrusted", "IPC sender is not the owned renderer");
    }
    validatePayloadSize(payload);

    if (channel === IPC_CHANNELS.getShellInfo) {
      if (!EmptyPayloadSchema.safeParse(payload).success) {
        throw new IpcError("payload-invalid", "IPC payload must be an empty object");
      }
      return ShellInfoSchema.parse(this.#dependencies.getShellInfo());
    }

    const parsed = LifecyclePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcError("payload-invalid", "IPC lifecycle payload is invalid");
    }
    return this.#dependencies.lifecycle.record(parsed.data.event);
  }
}

export function electronShellInfo(): ShellInfo {
  return {
    schemaVersion: 1,
    runtime: "electron",
    backend: "unavailable",
    capabilities: {
      core: "unavailable",
      helper: "unavailable",
      systemProxy: "unavailable",
      tun: "unavailable",
      updater: "unavailable",
    },
  };
}
