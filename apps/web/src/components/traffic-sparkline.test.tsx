import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSmoothSparklinePath,
  createSmoothSparklinePaths,
  TrafficSparkline,
} from "./traffic-sparkline";

function installMatchMedia(reduced = false) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      addEventListener: vi.fn(),
      matches: reduced,
      removeEventListener: vi.fn(),
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("TrafficSparkline", () => {
  it("creates bounded monotone cubic paths for growing and fixed windows", () => {
    const growing = createSmoothSparklinePaths([2, 8, 4]);
    const rolling = createSmoothSparklinePaths([8, 4, 6, 3]);

    expect(growing.linePath).toContain(" C ");
    expect(rolling.linePath).toContain(" C ");
    expect(createSmoothSparklinePath(growing.points)).not.toContain(" L ");
    for (const point of [...growing.points, ...rolling.points]) {
      expect(point.y).toBeGreaterThanOrEqual(2);
      expect(point.y).toBeLessThanOrEqual(32);
    }
  });

  it("interpolates incoming samples, cancels an interrupted animation, and cleans up on unmount", async () => {
    installMatchMedia();
    let nextFrameId = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = ++nextFrameId;
      callbacks.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
      cancelled.push(frameId);
      callbacks.delete(frameId);
    });

    const view = render(<TrafficSparkline color="blue" data={[1, 4]} id="download" />);
    const initial = view.container.querySelectorAll("path")[1].getAttribute("d");
    view.rerender(<TrafficSparkline color="blue" data={[1, 4, 2]} id="download" />);
    expect(callbacks.size).toBe(1);

    await act(async () => {
      const [frameId, callback] = [...callbacks.entries()][0];
      callbacks.delete(frameId);
      callback(performance.now() + 90);
    });
    expect(view.container.querySelectorAll("path")[1].getAttribute("d")).not.toBe(initial);

    view.rerender(<TrafficSparkline color="blue" data={[1, 5, 2]} id="download" />);
    expect(cancelled.length).toBeGreaterThan(0);
    view.unmount();
    expect(cancelled.length).toBeGreaterThan(1);
  });

  it("renders the newest curve directly when reduced motion is preferred", () => {
    installMatchMedia(true);
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    const view = render(<TrafficSparkline color="blue" data={[1, 4]} id="download" />);
    view.rerender(<TrafficSparkline color="blue" data={[1, 4, 2]} id="download" />);

    expect(requestFrame).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll("path")[1]).toHaveAttribute(
      "d",
      createSmoothSparklinePaths([1, 4, 2]).linePath,
    );
  });
});
