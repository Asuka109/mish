import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTrafficSparklineData,
  createTrafficSparklineGeometry,
  TRAFFIC_SPARKLINE_MAX_SAMPLES,
  TRAFFIC_SPARKLINE_WIDTH,
  TrafficSparkline,
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

  it("right-aligns an initially growing series to the end of the 60-sample domain", () => {
    const data = createTrafficSparklineData("download", [12, 24, 18]);

    expect(data[0].data).toEqual([
      { x: 57, y: 12 },
      { x: 58, y: 24 },
      { x: 59, y: 18 },
    ]);
  });

  it("uses a strict 60-sample rolling window and anchors its latest point on the right", () => {
    const data = createTrafficSparklineData(
      "download",
      Array.from({ length: 64 }, (_, index) => index),
    );
    const geometry = createTrafficSparklineGeometry([1, 4, 2]);

    expect(data[0].data).toHaveLength(TRAFFIC_SPARKLINE_MAX_SAMPLES);
    expect(data[0].data[0]).toMatchObject({ x: 0, y: 4 });
    expect(data[0].data.at(-1)).toMatchObject({ x: 59, y: 63 });
    expect(geometry.points.at(-1)?.x).toBe(TRAFFIC_SPARKLINE_WIDTH - 12);
  });

  it("creates a finite monotone path from non-negative bounded points", () => {
    const geometry = createTrafficSparklineGeometry([0, 80, 12, 60, 0]);

    expect(geometry.path).toMatch(/^M/);
    expect(geometry.path).not.toContain("NaN");
    for (const point of geometry.points) {
      expect(point.y).toBeGreaterThanOrEqual(2);
      expect(point.y).toBeLessThanOrEqual(32);
    }
  });

  it("animates only the newest tail clip and replaces it on an interrupted sample", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 4, 2]} id="download" />);
    const firstTail = view.container.querySelector(".traffic-sparkline-tail");

    expect(view.container.querySelector(".traffic-sparkline")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(view.container.querySelector(".traffic-sparkline-tail-clip")).toHaveClass("is-animated");

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 4, 2, 7]} id="download" />);
    expect(view.container.querySelector(".traffic-sparkline-tail")).not.toBe(firstTail);
  });

  it("renders the new tail directly when reduced motion is enabled", () => {
    vi.restoreAllMocks();
    mockReducedMotion(true);

    const view = render(<TrafficSparkline color="#2f855a" data={[1, 3]} id="upload" />);
    expect(view.container.querySelector(".traffic-sparkline-tail-clip")).not.toHaveClass(
      "is-animated",
    );
  });

  it("renders no chart surface for an empty session series", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[]} id="upload" />);
    expect(view.container.querySelector("svg")).toBeNull();
  });
});
