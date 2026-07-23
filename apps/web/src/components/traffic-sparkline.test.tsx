import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTrafficSamples,
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

describe("TrafficSparkline", () => {
  beforeEach(() => mockReducedMotion(false));
  afterEach(() => vi.restoreAllMocks());

  it("keeps the viewport empty until the third session sample arrives", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 2]} />);

    expect(view.container.querySelector(".traffic-sparkline")).toBeInTheDocument();
    expect(view.container.querySelector("svg")).toBeNull();

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3]} />);
    expect(view.container.querySelector(".recharts-surface")).toBeInTheDocument();
  });

  it("uses the fixed 60-sample domain and appends the next sample at its right edge", () => {
    expect(createTrafficSamples([0, 24, 18])).toEqual([
      { value: 0, x: 57 },
      { value: 24, x: 58 },
      { value: 18, x: 59 },
    ]);
  });

  it("retains only the latest bounded sample window", () => {
    const samples = Array.from({ length: TRAFFIC_SPARKLINE_MAX_SAMPLES + 4 }, (_, index) => index);

    expect(sanitizeTrafficSamples(samples)).toEqual(samples.slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES));
  });

  it("normalizes invalid samples before handing them to Recharts", () => {
    expect(sanitizeTrafficSamples([Number.NaN, Number.POSITIVE_INFINITY, -1, 3])).toEqual([
      0, 0, 0, 3,
    ]);
  });

  it("clears the chart on reset and starts a fresh chart after relaunch", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[4, 5, 6]} />);

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[]} />);
    expect(view.container.querySelector("svg")).toBeNull();

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 0, 2]} />);
    expect(view.container.querySelector(".recharts-surface")).toBeInTheDocument();
  });

  it("marks reduced-motion rendering so the chart animation is disabled", () => {
    mockReducedMotion(true);
    const view = render(<TrafficSparkline color="#2f855a" data={[1, 3, 2]} />);

    expect(view.container.querySelector(".traffic-sparkline")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );
  });
});
