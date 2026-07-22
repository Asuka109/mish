import { render } from "@testing-library/react";
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
  it("creates bounded monotone cubic paths on a 60-sample grid", () => {
    const growing = createSmoothSparklinePaths([2, 8, 4]);
    const rolling = createSmoothSparklinePaths(Array.from({ length: 64 }, (_, index) => index));

    expect(growing.linePath).toContain(" C ");
    expect(createSmoothSparklinePath(growing.points)).not.toContain(" L ");
    expect(rolling.points).toHaveLength(60);
    for (const point of [...growing.points, ...rolling.points]) {
      expect(point.y).toBeGreaterThanOrEqual(2);
      expect(point.y).toBeLessThanOrEqual(32);
    }
  });

  it("keeps the existing path fixed and animates only the incoming tail segment", () => {
    installMatchMedia();
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });

    const view = render(<TrafficSparkline color="blue" data={[1, 4]} id="download" />);
    const initialPaths = view.container.querySelectorAll("path[stroke]");
    const initialPath = initialPaths[initialPaths.length - 1]?.getAttribute("d");
    view.rerender(<TrafficSparkline color="blue" data={[1, 4, 2]} id="download" />);

    const paths = view.container.querySelectorAll("path[stroke]");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toHaveAttribute("d", initialPath ?? "");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(paths[1]).toHaveAttribute("pathLength", "1");
  });

  it("cancels an interrupted tail animation and skips animation for reduced motion", () => {
    installMatchMedia();
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    const view = render(<TrafficSparkline color="blue" data={[1, 4]} id="download" />);
    view.rerender(<TrafficSparkline color="blue" data={[1, 4, 2]} id="download" />);
    view.rerender(<TrafficSparkline color="blue" data={[1, 4, 2, 5]} id="download" />);
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    installMatchMedia(true);
    const reducedAnimate = vi.fn();
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: reducedAnimate,
    });
    const reduced = render(<TrafficSparkline color="blue" data={[1, 4]} id="upload" />);
    reduced.rerender(<TrafficSparkline color="blue" data={[1, 4, 2]} id="upload" />);
    expect(reducedAnimate).not.toHaveBeenCalled();
  });
});
