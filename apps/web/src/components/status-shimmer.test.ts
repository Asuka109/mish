import { describe, expect, it, vi } from "vitest";
import {
  advanceStatusShimmerAnimationTime,
  createStatusShimmerAnimationLoop,
  getStatusShimmerAnimationPolicy,
  STATUS_SHIMMER_UNFOCUSED_FRAME_RATE,
  type StatusShimmerAnimationPolicy,
} from "./status-shimmer";

function targetDocument({ focused, hidden = false }: { focused: boolean; hidden?: boolean }) {
  return {
    hasFocus: () => focused,
    hidden,
  } as unknown as Document;
}

function createAnimationHarness(initialPolicy: StatusShimmerAnimationPolicy) {
  let policy = initialPolicy;
  let nextHandle = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const draw = vi.fn();

  const loop = createStatusShimmerAnimationLoop({
    cancelFrame: (handle) => frames.delete(handle),
    clearTimer: (handle) => timers.delete(handle),
    draw,
    getPolicy: () => policy,
    requestFrame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    setTimer: (callback, delay) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, delay });
      return handle;
    },
  });

  return {
    draw,
    frames,
    loop,
    runFrame(timestamp: number) {
      const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      expect(entry).toBeDefined();
      if (!entry) return;
      frames.delete(entry[0]);
      entry[1](timestamp);
    },
    runTimer() {
      const entry = timers.entries().next().value as
        | [number, { callback: () => void; delay: number }]
        | undefined;
      expect(entry).toBeDefined();
      if (!entry) return;
      timers.delete(entry[0]);
      entry[1].callback();
    },
    setPolicy(nextPolicy: StatusShimmerAnimationPolicy) {
      policy = nextPolicy;
    },
    timers,
  };
}

describe("status shimmer animation policy", () => {
  it("preserves adaptive animation while visible and focused", () => {
    expect(getStatusShimmerAnimationPolicy(false, targetDocument({ focused: true }), 45)).toEqual({
      frameRate: 45,
      mode: "focused",
    });
  });

  it("uses a bounded low-power budget while visible and unfocused", () => {
    expect(STATUS_SHIMMER_UNFOCUSED_FRAME_RATE).toBe(24);
    expect(getStatusShimmerAnimationPolicy(false, targetDocument({ focused: false }), 60)).toEqual({
      frameRate: STATUS_SHIMMER_UNFOCUSED_FRAME_RATE,
      mode: "unfocused",
    });
  });

  it("stops while hidden and uses one static frame under reduced motion", () => {
    expect(
      getStatusShimmerAnimationPolicy(false, targetDocument({ focused: true, hidden: true }), 60),
    ).toEqual({ frameRate: 0, mode: "stopped" });
    expect(getStatusShimmerAnimationPolicy(true, targetDocument({ focused: false }), 60)).toEqual({
      frameRate: 0,
      mode: "static",
    });
    expect(
      getStatusShimmerAnimationPolicy(true, targetDocument({ focused: false, hidden: true }), 60),
    ).toEqual({ frameRate: 0, mode: "stopped" });
  });

  it("advances logical time by wall-clock time independently of the render rate", () => {
    const firstFrame = advanceStatusShimmerAnimationTime(null, 12_000, 0);
    const lowRateFrame = advanceStatusShimmerAnimationTime(
      firstFrame,
      12_000 + 1000 / STATUS_SHIMMER_UNFOCUSED_FRAME_RATE,
      1000 / STATUS_SHIMMER_UNFOCUSED_FRAME_RATE,
    );

    expect(firstFrame).toBe(12);
    expect(lowRateFrame).toBeCloseTo(12 + 1 / STATUS_SHIMMER_UNFOCUSED_FRAME_RATE);
  });
});

describe("status shimmer animation loop", () => {
  const focused = { frameRate: 60, mode: "focused" } as const;
  const unfocused = {
    frameRate: STATUS_SHIMMER_UNFOCUSED_FRAME_RATE,
    mode: "unfocused",
  } as const;
  const stopped = { frameRate: 0, mode: "stopped" } as const;
  const staticFrame = { frameRate: 0, mode: "static" } as const;

  it("switches from adaptive RAF to a single low-rate timer without duplicate loops", () => {
    const harness = createAnimationHarness(focused);
    harness.loop.sync();
    expect(harness.frames.size).toBe(1);

    harness.runFrame(100);
    expect(harness.draw).toHaveBeenLastCalledWith(100, 0, focused);
    expect(harness.frames.size).toBe(1);

    harness.setPolicy(unfocused);
    harness.loop.sync();
    harness.loop.sync();
    expect(harness.frames.size).toBe(1);
    expect(harness.timers.size).toBe(0);

    harness.runFrame(300);
    expect(harness.draw).toHaveBeenLastCalledWith(300, 200, unfocused);
    expect(harness.frames.size).toBe(0);
    expect(harness.timers.size).toBe(1);
    expect([...harness.timers.values()][0]?.delay).toBeCloseTo(
      1000 / STATUS_SHIMMER_UNFOCUSED_FRAME_RATE,
    );

    harness.runTimer();
    expect(harness.frames.size).toBe(1);
    expect(harness.timers.size).toBe(0);
  });

  it("cancels all work while hidden and resumes without counting hidden time", () => {
    const harness = createAnimationHarness(unfocused);
    harness.loop.sync();
    harness.runFrame(100);
    expect(harness.timers.size).toBe(1);

    harness.setPolicy(stopped);
    harness.loop.sync();
    expect(harness.frames.size).toBe(0);
    expect(harness.timers.size).toBe(0);

    harness.setPolicy(focused);
    harness.loop.sync();
    harness.runFrame(10_000);
    expect(harness.draw).toHaveBeenLastCalledWith(10_000, 0, focused);
    expect(harness.frames.size).toBe(1);
  });

  it("draws reduced motion once and cleans up pending work", () => {
    const harness = createAnimationHarness(focused);
    harness.loop.sync();
    harness.runFrame(100);

    harness.setPolicy(staticFrame);
    harness.loop.sync();
    expect(harness.frames.size).toBe(1);
    harness.runFrame(200);
    expect(harness.draw).toHaveBeenLastCalledWith(200, 0, staticFrame);
    expect(harness.frames.size).toBe(0);
    expect(harness.timers.size).toBe(0);

    harness.setPolicy(unfocused);
    harness.loop.sync();
    harness.loop.dispose();
    expect(harness.frames.size).toBe(0);
    expect(harness.timers.size).toBe(0);
  });
});
