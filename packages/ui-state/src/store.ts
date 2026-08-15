import {
  batch as tanstackBatch,
  createAtom,
  createStore as createTanStackStore,
} from "@tanstack/store";
import { useMemo, useSyncExternalStore } from "react";
import type { Store as TanStackStore } from "@tanstack/store";

export type StateUpdater<T> = T | ((previous: T) => T);
export type Equality<T> = (previous: T, next: T) => boolean;
export type Listener = () => void;

/**
 * The smallest renderer-neutral readable contract shared by Web and RN.
 *
 * A readable is deliberately not a state authority: it can only expose a
 * selected value and a subscription. Remote snapshots and lifecycle state do
 * not belong in this package's store.
 */
export interface MishReadable<T> {
  readonly get: () => T;
  readonly subscribe: (listener: Listener) => () => void;
}

export interface MishStore<T> extends MishReadable<T> {
  /** The framework-agnostic TanStack Store primitive. */
  readonly core: TanStackStore<T>;
  readonly getState: () => T;
  readonly setState: (updater: StateUpdater<T>) => void;
  readonly select: <TSelected>(
    selector: (state: T) => TSelected,
    equality?: Equality<TSelected>,
  ) => MishReadable<TSelected>;
  readonly derived: <TValues extends readonly unknown[], TDerived>(
    sources: { readonly [K in keyof TValues]: MishReadable<TValues[K]> },
    derive: (...values: TValues) => TDerived,
    equality?: Equality<TDerived>,
  ) => MishReadable<TDerived>;
  readonly batch: (fn: () => void) => void;
}

function toReadable<T>(read: () => T, equality: Equality<T> = Object.is): MishReadable<T> {
  const atom = createAtom(read, { compare: equality });

  return {
    get: atom.get,
    subscribe(listener) {
      const subscription = atom.subscribe(() => listener());
      return subscription.unsubscribe;
    },
  };
}

function writeState<T>(core: TanStackStore<T>, updater: StateUpdater<T>): void {
  core.setState(typeof updater === "function" ? (updater as (previous: T) => T) : () => updater);
}

function createDerived<TValues extends readonly unknown[], TDerived>(
  sources: { readonly [K in keyof TValues]: MishReadable<TValues[K]> },
  derive: (...values: TValues) => TDerived,
  equality: Equality<TDerived> = Object.is,
): MishReadable<TDerived> {
  return toReadable(() => {
    const call = derive as unknown as (...values: readonly unknown[]) => TDerived;
    return call(...sources.map((source) => source.get()));
  }, equality);
}

const identitySelector = <T>(state: T): T => state;

/**
 * Create the only cross-component UI state primitive admitted by the
 * TypeScript cutover. The core has no DOM, renderer, persistence, or remote
 * transport dependency and is safe to load from Hermes.
 */
export function createStore<T>(initialState: T): MishStore<T> {
  const core = createTanStackStore(initialState);
  const root = toReadable(core.get);

  const store: MishStore<T> = {
    ...root,
    core,
    getState: core.get,
    setState: (updater) => writeState(core, updater),
    select: (selector, equality = Object.is) => toReadable(() => selector(core.get()), equality),
    derived: createDerived,
    batch: tanstackBatch,
  };

  return store;
}

/**
 * React's renderer-neutral external-store adapter. It only uses React core;
 * it intentionally does not import a browser renderer, a DOM-specific Store
 * adapter, or any browser global, so the same adapter can be composed by
 * RN/Hermes.
 */
export function useMishStore<T, TSelected = T>(
  store: MishStore<T>,
  selector: (state: T) => TSelected = identitySelector as (state: T) => TSelected,
  equality: Equality<TSelected> = Object.is,
): TSelected {
  const readable = useMemo(() => store.select(selector, equality), [equality, selector, store]);

  return useSyncExternalStore(readable.subscribe, readable.get, readable.get);
}

/** Explicitly expose batching to non-React callers. */
export function batch(fn: () => void): void {
  tanstackBatch(fn);
}
