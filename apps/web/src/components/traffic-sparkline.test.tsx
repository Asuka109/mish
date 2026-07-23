import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSparklineGeometry,
  sanitizeTrafficSamples,
  TrafficSparkline,
  TRAFFIC_SPARKLINE_MAX_SAMPLES,
} from "./traffic-sparkline";

function mockReducedMotion(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        addEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(prefers-reduced-motion: reduce)" && matches,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

function sparklinePath(view: ReturnType<typeof render>): SVGPathElement | null {
  return view.container.querySelector("path[stroke]");
}

describe("TrafficSparkline", () => {
  beforeEach(() => mockReducedMotion(false));
  afterEach(() => vi.restoreAllMocks());

  it("keeps the viewport empty until the third session sample arrives", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 2]} />);

    expect(view.container.querySelector(".traffic-sparkline")).toBeInTheDocument();
    expect(view.container.querySelector("svg")).toBeNull();

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3]} />);
    expect(sparklinePath(view)).toBeInTheDocument();
  });

  it("uses one persistent SVG when an observed sample is appended", () => {
    mockReducedMotion(true);
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3]} />);
    const surface = view.container.querySelector("svg");
    const before = sparklinePath(view)?.getAttribute("d");

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3, 4]} />);

    expect(view.container.querySelector("svg")).toBe(surface);
    expect(sparklinePath(view)?.getAttribute("d")).not.toBe(before);
  });

  it("interpolates an appended point without recreating the SVG surface", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3]} />);
    const surface = view.container.querySelector("svg");
    const before = sparklinePath(view)?.getAttribute("d");

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3, 8]} />);
    const atStart = sparklinePath(view)?.getAttribute("d");
    act(() => frames.shift()?.(200));

    expect(view.container.querySelector("svg")).toBe(surface);
    expect(atStart).not.toBe(before);
    expect(sparklinePath(view)?.getAttribute("d")).not.toBe(atStart);
  });

  it("draws a smooth, right-aligned, non-negative curve", () => {
    const geometry = createSparklineGeometry(sanitizeTrafficSamples([-5, 24, 18]), 27);

    expect(geometry.line).toContain("M 347.79661016949154 34");
    expect(geometry.line).toContain(" C ");
    expect(geometry.area).toContain("L 360 34");
  });

  it("keeps the vertical projection stable until a new maximum arrives", () => {
    mockReducedMotion(true);
    const view = render(<TrafficSparkline color="#2f6fdc" data={[10, 20, 15]} />);
    const before = sparklinePath(view)?.getAttribute("d");

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[10, 20, 15, 5]} />);
    const afterLowSample = sparklinePath(view)?.getAttribute("d");
    view.rerender(<TrafficSparkline color="#2f6fdc" data={[10, 20, 15, 5, 100]} />);
    const afterMaximum = sparklinePath(view)?.getAttribute("d");

    expect(afterLowSample).toContain(" 3.0909090909090935");
    expect(afterLowSample).not.toBe(before);
    expect(afterMaximum).not.toBe(afterLowSample);
  });

  it("retains only the latest bounded sample window", () => {
    const samples = Array.from({ length: TRAFFIC_SPARKLINE_MAX_SAMPLES + 4 }, (_, index) => index);

    expect(sanitizeTrafficSamples(samples)).toEqual(samples.slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES));
  });

  it("normalizes invalid samples without producing invalid SVG geometry", () => {
    const samples = sanitizeTrafficSamples([Number.NaN, Number.POSITIVE_INFINITY, -1, 3]);
    const geometry = createSparklineGeometry(samples, 4);

    expect(samples).toEqual([0, 0, 0, 3]);
    expect(geometry.line).not.toContain("NaN");
    expect(geometry.line).not.toContain("Infinity");
  });

  it("clears the surface on reset and starts a fresh curve after relaunch", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[4, 5, 6]} />);

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[]} />);
    expect(view.container.querySelector("svg")).toBeNull();

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 0, 2]} />);
    expect(sparklinePath(view)).toBeInTheDocument();
  });

  it("applies an appended sample directly when reduced motion is enabled", () => {
    mockReducedMotion(true);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    const view = render(<TrafficSparkline color="#2f855a" data={[1, 3, 2]} />);

    view.rerender(<TrafficSparkline color="#2f855a" data={[1, 3, 2, 5]} />);

    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("cancels a pending curve animation when unmounted", () => {
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const view = render(<TrafficSparkline color="#2f855a" data={[1, 3, 2]} />);

    view.rerender(<TrafficSparkline color="#2f855a" data={[1, 3, 2, 5]} />);
    view.unmount();

    expect(cancelFrame).toHaveBeenCalled();
  });
});
