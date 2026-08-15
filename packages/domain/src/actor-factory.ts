import { createActor, type AnyActorLogic } from "xstate";

import { captureMachine, type CaptureContext, type CaptureEvent } from "./capture.js";
import { coreMachine, type CoreContext, type CoreEvent } from "./core.js";
import { profileMachine, type ProfileContext, type ProfileEvent } from "./profile.js";
import { rpcSessionMachine, type RpcSessionContext, type RpcSessionEvent } from "./rpc.js";
import { runtimeMachine, type RuntimeContext, type RuntimeEvent } from "./runtime.js";
import { settingsMachine, type SettingsContext, type SettingsEvent } from "./settings.js";
import { updaterMachine, type UpdaterContext, type UpdaterEvent } from "./updater.js";
import { vpnMachine, type VpnContext, type VpnEvent } from "./vpn.js";
import type { ActorEnvironment } from "./shared.js";

/** The bounded state value exposed by a domain actor snapshot. */
export interface DomainStateMap {
  readonly [key: string]: DomainStateValue;
}

export type DomainStateValue = string | DomainStateMap;

export type DomainActorStatus = "active" | "done" | "error" | "stopped";

export interface DomainActorSnapshot<TContext> {
  readonly context: TContext;
  readonly value: DomainStateValue;
  readonly status: DomainActorStatus;
  readonly error?: unknown;
}

export interface DomainActorSubscription {
  unsubscribe(): void;
}

export interface DomainActor<TEvent extends { readonly type: string }, TContext> {
  start(): DomainActor<TEvent, TContext>;
  stop(): DomainActor<TEvent, TContext>;
  send(event: TEvent): void;
  getSnapshot(): DomainActorSnapshot<TContext>;
  subscribe(listener: (snapshot: DomainActorSnapshot<TContext>) => void): DomainActorSubscription;
}

export const domainActorKinds = [
  "capture",
  "core",
  "profile",
  "rpcSession",
  "runtime",
  "settings",
  "updater",
  "vpn",
] as const;

export type DomainActorKind = (typeof domainActorKinds)[number];

type DomainActorContracts = {
  capture: DomainActor<CaptureEvent, CaptureContext>;
  core: DomainActor<CoreEvent, CoreContext>;
  profile: DomainActor<ProfileEvent, ProfileContext>;
  rpcSession: DomainActor<RpcSessionEvent, RpcSessionContext>;
  runtime: DomainActor<RuntimeEvent, RuntimeContext>;
  settings: DomainActor<SettingsEvent, SettingsContext>;
  updater: DomainActor<UpdaterEvent, UpdaterContext>;
  vpn: DomainActor<VpnEvent, VpnContext>;
};

export type DomainActorFor<K extends DomainActorKind> = DomainActorContracts[K];

const machines = {
  capture: captureMachine,
  core: coreMachine,
  profile: profileMachine,
  rpcSession: rpcSessionMachine,
  runtime: runtimeMachine,
  settings: settingsMachine,
  updater: updaterMachine,
  vpn: vpnMachine,
} as const;

/**
 * Creates an XState actor owned by the domain package.
 *
 * The returned actor is deliberately the XState actor itself: this function
 * only hides construction and keeps the lifecycle authority in the machine.
 * Consumers can start, subscribe, send events, and stop without importing
 * XState or reaching into a machine implementation.
 */
export const createDomainActor = <K extends DomainActorKind>(
  kind: K,
  input: ActorEnvironment,
): DomainActorFor<K> =>
  createActor(machines[kind] as AnyActorLogic, { input }) as unknown as DomainActorFor<K>;
