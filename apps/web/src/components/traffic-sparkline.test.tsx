import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const chartInstances = vi.hoisted(
  () =>
    [] as Array<{
      destroy: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("chart.js", () => ({
  Chart: class {
    static register = vi.fn();
    data: unknown;
    destroy = vi.fn();
    options: unknown;
    stop = vi.fn();
    update = vi.fn();
    constructor(_canvas: HTMLCanvasElement, config: { data: unknown; options: unknown }) {
      this.data = config.data;
      this.options = config.options;
      chartInstances.push(this);
    }
  },
  Filler: class {},
  LineController: class {},
  LineElement: class {},
  LinearScale: class {},
  PointElement: class {},
}));

import {
  createTrafficSparklineConfig,
  TRAFFIC_SPARKLINE_MAX_SAMPLES,
  TrafficSparkline,
} from "./traffic-sparkline";

describe("TrafficSparkline", () => {
  it("uses Chart.js monotone curves and its bounded update animation", () => {
    const config = createTrafficSparklineConfig("#2f6fdc", [2, 8, 4], false);
    const dataset = config.data.datasets[0];

    expect(dataset.cubicInterpolationMode).toBe("monotone");
    expect(dataset.pointRadius).toBe(0);
    expect(config.options?.animation).toEqual({ duration: 180, easing: "easeOutQuart" });
  });

  it("limits every chart to 60 samples and disables interpolation for reduced motion", () => {
    const config = createTrafficSparklineConfig(
      "#2f6fdc",
      Array.from({ length: 64 }, (_, index) => index),
      true,
    );

    expect(config.data.labels).toHaveLength(TRAFFIC_SPARKLINE_MAX_SAMPLES);
    expect(config.data.datasets[0].data).toHaveLength(TRAFFIC_SPARKLINE_MAX_SAMPLES);
    expect(config.options?.animation).toBe(false);
  });

  it("reconciles updates through Chart.js and disposes the chart on unmount", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 4]} id="download" />);
    const instance = chartInstances.at(-1);
    if (!instance) throw new Error("Chart was not created");

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 4, 2]} id="download" />);
    expect(instance.stop).toHaveBeenCalled();
    expect(instance.update).toHaveBeenCalledWith("none");
    view.unmount();
    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });
});
