import { act, render, waitFor } from "@testing-library/react";
import type { OrpcEventValue } from "@mish/contracts";
import type { OrpcChannel, OrpcSessionState } from "@mish/orpc-client";
import { describe, expect, it } from "vitest";
import { StrictMode } from "react";
import { createQueryClient, useQueryClient } from "@mish/ui-state";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import {
  CUTOVER_SESSION_QUERY_KEY,
  CUTOVER_SESSION_STREAM_QUERY_KEY,
  createCutoverSessionActor,
  reduceSessionEvent,
  type CutoverSessionFactory,
  type CutoverSessionPort,
} from "./cutover-session-actor";
import { CutoverWebComposition } from "./cutover-composition";

loadAllLocales();

function event(sequence: number, overrides: Partial<OrpcEventValue> = {}): OrpcEventValue {
  return {
    correlationId: "event-1",
    parentEpoch: 1,
    revision: 1,
    sequence,
    sessionGeneration: 1,
    value: "changed",
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

async function waitForState(
  actor: ReturnType<typeof createCutoverSessionActor>["actor"],
  expected: string,
): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    if (String(actor.getSnapshot().value) === expected) return;
    await Promise.resolve();
  }
  throw new Error(`Expected actor state ${expected}, got ${String(actor.getSnapshot().value)}`);
}

class PendingIterator {
  readonly iterator: AsyncIterableIterator<OrpcEventValue>;
  private resolveNext: ((result: IteratorResult<OrpcEventValue>) => void) | undefined;
  returnCount = 0;

  get pending(): boolean {
    return this.resolveNext !== undefined;
  }

  constructor(private readonly cleanupError?: Error) {
    this.iterator = {
      [Symbol.asyncIterator]: () => this.iterator,
      next: () =>
        new Promise<IteratorResult<OrpcEventValue>>((resolve) => {
          this.resolveNext = resolve;
        }),
      return: async () => {
        this.returnCount += 1;
        if (this.cleanupError) throw this.cleanupError;
        this.resolveNext?.({ done: true, value: undefined } as IteratorResult<OrpcEventValue>);
        return { done: true, value: undefined } as IteratorResult<OrpcEventValue>;
      },
    };
  }

  resolve(value: IteratorResult<OrpcEventValue>): void {
    this.resolveNext?.(value);
  }
}

class FakeAuthority {
  state: OrpcSessionState = "disconnected";
  sessionGeneration = 0;
  parentEpoch = 0;
  revision = 0;
  connectCount = 0;
  disposeCount = 0;
  active = false;
  reconnectResolver: (() => void) | undefined;
  lastIterator: PendingIterator | undefined;

  constructor(
    private readonly options: {
      readonly cleanupError?: Error;
      readonly deferReconnect?: boolean;
      readonly onActiveChange?: (active: boolean) => void;
      readonly connectError?: Error;
    } = {},
  ) {}

  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.state === "disposed") throw new Error("disposed");
    if (this.options.connectError) throw this.options.connectError;
    if (this.options.deferReconnect && this.connectCount > 1) {
      await new Promise<void>((resolve) => {
        this.reconnectResolver = () => {
          if (this.state === "disposed") return;
          this.markConnected();
          resolve();
        };
      });
      return;
    }
    this.markConnected();
  }

  private markConnected(): void {
    this.state = "connected-current";
    this.sessionGeneration += 1;
    this.parentEpoch += 1;
    this.revision = 1;
    if (!this.active) {
      this.active = true;
      this.options.onActiveChange?.(true);
    }
  }

  disconnect(): void {
    this.state = "disconnected";
    if (this.active) {
      this.active = false;
      this.options.onActiveChange?.(false);
    }
  }

  dispose(): void {
    this.disposeCount += 1;
    this.state = "disposed";
    if (this.active) {
      this.active = false;
      this.options.onActiveChange?.(false);
    }
  }

  async watchEvents(): Promise<AsyncIterableIterator<OrpcEventValue>> {
    const pending = new PendingIterator(this.options.cleanupError);
    this.lastIterator = pending;
    return pending.iterator;
  }
}

function sessionPort(authority: FakeAuthority): CutoverSessionPort {
  return {
    authority: authority as unknown as CutoverSessionPort["authority"],
    createChannel: () => ({}) as OrpcChannel,
  };
}

function sessionFactory(authorities: FakeAuthority[]): CutoverSessionFactory {
  return {
    createAuthority: () => {
      const authority = new FakeAuthority();
      authorities.push(authority);
      return authority as unknown as CutoverSessionPort["authority"];
    },
    createChannel: () => ({}) as OrpcChannel,
  };
}

describe("CUT-03 session actor/query projection", () => {
  it("rejects stale generation, revision, and sequence while bounding stream chunks", () => {
    let current = reduceSessionEvent(undefined, event(1));
    expect(reduceSessionEvent(current, event(1))).toBe(current);
    expect(reduceSessionEvent(current, event(2, { revision: 2 }))).toBe(current);
    expect(reduceSessionEvent(current, event(2, { sessionGeneration: 0 }))).toBe(current);

    for (let sequence = 2; sequence <= 260; sequence += 1) {
      current = reduceSessionEvent(current, event(sequence));
    }
    expect(current.chunks).toHaveLength(256);
    expect(current.chunks[0]?.sequence).toBe(5);
    expect(reduceSessionEvent(current, event(1, { sessionGeneration: 2 }))).toEqual({
      chunks: [event(1, { sessionGeneration: 2 })],
      generation: 2,
      lastSequence: 1,
      lastValue: "changed",
      parentEpoch: 1,
      revision: 1,
    });
  });

  it("clears old session and stream Query entries at actor setup and reconnect", async () => {
    const queryClient = createQueryClient();
    const authority = new FakeAuthority({ deferReconnect: true });
    queryClient.setQueryData(CUTOVER_SESSION_QUERY_KEY, {
      generation: 77,
      parentEpoch: 77,
      revision: 77,
    });
    queryClient.setQueryData(CUTOVER_SESSION_STREAM_QUERY_KEY, {
      generation: 77,
      parentEpoch: 77,
      revision: 77,
      lastSequence: 77,
      lastValue: "ready" as const,
      chunks: [],
    });

    const handle = createCutoverSessionActor({
      queryClient,
      session: sessionPort(authority),
    });
    expect(queryClient.getQueryData(CUTOVER_SESSION_QUERY_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(CUTOVER_SESSION_STREAM_QUERY_KEY)).toBeUndefined();

    handle.actor.start();
    handle.actor.send({ type: "CONNECT" });
    await waitForState(handle.actor, "connected-current");
    queryClient.setQueryData(CUTOVER_SESSION_QUERY_KEY, {
      generation: 1,
      parentEpoch: 1,
      revision: 1,
    });
    queryClient.setQueryData(CUTOVER_SESSION_STREAM_QUERY_KEY, {
      generation: 1,
      parentEpoch: 1,
      revision: 1,
      lastSequence: 4,
      lastValue: "changed" as const,
      chunks: [event(4)],
    });

    handle.actor.send({ type: "RECONNECT" });
    await settle();
    expect(queryClient.getQueryData(CUTOVER_SESSION_QUERY_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(CUTOVER_SESSION_STREAM_QUERY_KEY)).toBeUndefined();

    authority.reconnectResolver?.();
    await waitForState(handle.actor, "connected-current");
    expect(queryClient.getQueryData(CUTOVER_SESSION_STREAM_QUERY_KEY)).toBeUndefined();
    await handle.dispose();
    queryClient.clear();
  });

  it("retires an authority synchronously for StrictMode setup/cleanup/setup", async () => {
    const queryClient = createQueryClient();
    let active = 0;
    let maxActive = 0;
    const authorities: FakeAuthority[] = [];
    const factory: CutoverSessionFactory = {
      createAuthority: () => {
        const authority = new FakeAuthority({
          onActiveChange: (isActive) => {
            active += isActive ? 1 : -1;
            maxActive = Math.max(maxActive, active);
          },
        });
        authorities.push(authority);
        return authority as unknown as CutoverSessionPort["authority"];
      },
      createChannel: () => ({}) as OrpcChannel,
    };

    const first = createCutoverSessionActor({
      queryClient,
      session: {
        authority: factory.createAuthority(),
        createChannel: factory.createChannel,
      },
    });
    first.actor.start();
    first.actor.send({ type: "CONNECT" });
    await waitForState(first.actor, "connected-current");

    const cleanup = first.dispose();
    const second = createCutoverSessionActor({
      queryClient,
      session: {
        authority: factory.createAuthority(),
        createChannel: factory.createChannel,
      },
    });
    second.actor.start();
    second.actor.send({ type: "CONNECT" });
    await waitForState(second.actor, "connected-current");
    await cleanup;

    expect(maxActive).toBe(1);
    expect(authorities[0]?.disposeCount).toBeGreaterThan(0);
    await second.dispose();
    expect(active).toBe(0);
  });

  it("exposes iterator cleanup failure once and rejects late chunks", async () => {
    const cleanupError = new Error("iterator cleanup failed");
    const queryClient = createQueryClient();
    const authority = new FakeAuthority({ cleanupError });
    const handle = createCutoverSessionActor({
      queryClient,
      session: sessionPort(authority),
    });
    handle.actor.start();
    handle.actor.send({ type: "CONNECT" });
    await waitForState(handle.actor, "connected-current");

    const first = handle.dispose();
    await expect(first).rejects.toBe(cleanupError);
    await expect(handle.dispose()).rejects.toBe(cleanupError);
    expect(authority.state).toBe("disposed");

    authority.lastIterator?.resolve({ done: false, value: event(99) });
    await settle();
    expect(queryClient.getQueryData(CUTOVER_SESSION_STREAM_QUERY_KEY)).toBeUndefined();
    queryClient.clear();
  });

  it("projects the stream Query value directly without storing remote data", async () => {
    const authorities: FakeAuthority[] = [];
    let queryClient: ReturnType<typeof createQueryClient> | undefined;
    function QueryProbe() {
      queryClient = useQueryClient();
      return null;
    }
    const view = render(
      <TypesafeI18n locale="en">
        <CutoverWebComposition session={sessionFactory(authorities)}>
          <QueryProbe />
        </CutoverWebComposition>
      </TypesafeI18n>,
    );
    await waitFor(() =>
      expect(view.container.querySelector("[data-cutover-session]")).toBeTruthy(),
    );
    await waitFor(() => expect(queryClient).toBeDefined());
    await waitFor(() => expect(authorities[0]?.lastIterator?.pending).toBe(true));
    act(() => {
      authorities[0]?.lastIterator?.resolve({
        done: false,
        value: event(8, { value: "ready" }),
      });
    });
    await waitFor(() => {
      const root = view.container.querySelector("[data-cutover-session]");
      expect(root).toHaveAttribute("data-last-sequence", "8");
      expect(root).toHaveAttribute("data-last-value", "ready");
      expect(root?.querySelector("output")).toHaveClass("sr-only");
    });
    view.unmount();
    await settle();
  });

  it("keeps StrictMode authority lifetimes fresh and non-overlapping", async () => {
    const authorities: FakeAuthority[] = [];
    let active = 0;
    let maxActive = 0;
    const session: CutoverSessionFactory = {
      createAuthority: () => {
        const authority = new FakeAuthority({
          onActiveChange: (isActive) => {
            active += isActive ? 1 : -1;
            maxActive = Math.max(maxActive, active);
          },
        });
        authorities.push(authority);
        return authority as unknown as CutoverSessionPort["authority"];
      },
      createChannel: () => ({}) as OrpcChannel,
    };
    const view = render(
      <StrictMode>
        <TypesafeI18n locale="en">
          <CutoverWebComposition session={session}>
            <span>strict content</span>
          </CutoverWebComposition>
        </TypesafeI18n>
      </StrictMode>,
    );

    await waitFor(() => expect(authorities).toHaveLength(2));
    await waitFor(() => expect(active).toBe(1));
    expect(maxActive).toBe(1);
    view.unmount();
    await waitFor(() => expect(active).toBe(0));
  });

  it("keeps a failed status accessible without reserving page layout", async () => {
    const authority = new FakeAuthority({ connectError: new Error("offline") });
    const view = render(
      <TypesafeI18n locale="en">
        <CutoverWebComposition
          session={{
            createAuthority: () => authority as unknown as CutoverSessionPort["authority"],
            createChannel: () => ({}) as OrpcChannel,
          }}
        >
          <span>content</span>
        </CutoverWebComposition>
      </TypesafeI18n>,
    );
    await waitFor(() => {
      expect(view.container.querySelector("[data-cutover-session='failed']")).toBeTruthy();
    });
    const status = view.container.querySelector("output");
    expect(status).toHaveClass("sr-only");
    expect(view.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    expect(view.getByText("content")).toBeInTheDocument();
    view.unmount();
    await settle();
  });
});
