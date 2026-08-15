import { describe, expect, it } from "vitest";

import { batch, createStore } from "../src/store.ts";

interface UiState {
  readonly count: number;
  readonly step: number;
  readonly theme: "light" | "dark";
}

describe("Mish Store adapter", () => {
  it("exposes core get/set/subscribe and unsubscribes cleanly", () => {
    const store = createStore<UiState>({ count: 0, step: 1, theme: "light" });
    const snapshots: UiState[] = [];
    const unsubscribe = store.subscribe(() => snapshots.push(store.getState()));

    store.setState((previous) => ({ ...previous, count: previous.count + 1 }));
    expect(store.core.get()).toEqual({ count: 1, step: 1, theme: "light" });
    expect(snapshots).toHaveLength(1);

    unsubscribe();
    store.setState((previous) => ({ ...previous, theme: "dark" }));
    expect(snapshots).toHaveLength(1);
  });

  it("coalesces nested batches and preserves the final state", () => {
    const store = createStore({ count: 0, step: 2 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.batch(() => {
      store.setState((previous) => ({ ...previous, count: 1 }));
      batch(() => {
        store.setState((previous) => ({ ...previous, count: previous.count + 1 }));
        store.setState((previous) => ({ ...previous, step: 3 }));
      });
    });

    expect(store.getState()).toEqual({ count: 2, step: 3 });
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("only notifies selected subscribers when their selection changes", () => {
    const store = createStore<UiState>({ count: 0, step: 1, theme: "light" });
    const count = store.select((state) => state.count);
    const selectedValues: number[] = [];
    const unsubscribe = count.subscribe(() => selectedValues.push(count.get()));

    store.setState((previous) => ({ ...previous, theme: "dark" }));
    expect(selectedValues).toEqual([]);

    store.setState((previous) => ({ ...previous, count: 1 }));
    expect(selectedValues).toEqual([1]);

    unsubscribe();
    store.setState((previous) => ({ ...previous, count: 2 }));
    expect(selectedValues).toEqual([1]);
  });

  it("tracks derived values from multiple selectors", () => {
    const store = createStore<UiState>({ count: 2, step: 3, theme: "light" });
    const count = store.select((state) => state.count);
    const step = store.select((state) => state.step);
    const total = store.derived(
      [count, step] as const,
      (currentCount, currentStep) => currentCount * currentStep,
    );
    const values: number[] = [];
    const unsubscribe = total.subscribe(() => values.push(total.get()));

    store.setState((previous) => ({ ...previous, theme: "dark" }));
    expect(values).toEqual([]);
    store.setState((previous) => ({ ...previous, step: 4 }));
    expect(values).toEqual([8]);

    unsubscribe();
  });

  it("survives a StrictMode-like unmount/remount cycle without leaked listeners", () => {
    const store = createStore({ count: 0 });
    let notifications = 0;
    const mount = (): (() => void) =>
      store.subscribe(() => {
        notifications += 1;
      });

    const firstMount = mount();
    firstMount();
    const secondMount = mount();
    store.setState((previous) => ({ count: previous.count + 1 }));
    expect(notifications).toBe(1);
    secondMount();

    store.setState((previous) => ({ count: previous.count + 1 }));
    expect(notifications).toBe(1);
  });
});
