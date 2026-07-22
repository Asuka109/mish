import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const highchartsMocks = vi.hoisted(() => ({
  chart: vi.fn(),
  charts: [] as Array<{
    addPoint: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    options: unknown;
    setData: ReturnType<typeof vi.fn>;
    setExtremes: ReturnType<typeof vi.fn>;
    updateYAxis: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("highcharts", () => ({
  default: { chart: highchartsMocks.chart },
}));

import { TrafficSparkline } from "./traffic-sparkline";

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
  beforeEach(() => {
    mockReducedMotion(false);
    highchartsMocks.charts.length = 0;
    highchartsMocks.chart.mockReset();
    highchartsMocks.chart.mockImplementation((container: HTMLElement, options: unknown) => {
      const surface = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      container.append(surface);
      const chart = {
        addPoint: vi.fn(),
        destroy: vi.fn(() => surface.remove()),
        options,
        setData: vi.fn(),
        setExtremes: vi.fn(),
        updateYAxis: vi.fn(),
      };
      highchartsMocks.charts.push(chart);
      return {
        destroy: chart.destroy,
        series: [{ addPoint: chart.addPoint, data: [], setData: chart.setData }],
        xAxis: [{ setExtremes: chart.setExtremes }],
        yAxis: [{ update: chart.updateYAxis }],
      };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps the graph empty until the third session sample arrives", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 2]} id="download" />);

    expect(view.container.querySelector("svg")).toBeNull();

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3]} id="download" />);
    expect(view.container.querySelector("svg")).not.toBeNull();
  });

  it("appends a newly observed sample without replacing the existing series", async () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3]} id="download" />);

    await waitFor(() => expect(highchartsMocks.chart).toHaveBeenCalledOnce());
    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3, 4]} id="download" />);

    await waitFor(() => expect(highchartsMocks.charts[0]?.addPoint).toHaveBeenCalledOnce());
    expect(highchartsMocks.charts[0]?.setData).not.toHaveBeenCalled();
  });

  it("does not redraw when projection returns a new array with identical samples", async () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3]} id="download" />);

    await waitFor(() => expect(highchartsMocks.chart).toHaveBeenCalledOnce());
    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 2, 3]} id="download" />);

    expect(highchartsMocks.charts[0]?.addPoint).not.toHaveBeenCalled();
    expect(highchartsMocks.charts[0]?.setData).not.toHaveBeenCalled();
  });

  it("shifts the oldest point when appending beyond the 60-sample window", async () => {
    const initialData = Array.from({ length: 60 }, (_, index) => index);
    const view = render(<TrafficSparkline color="#2f6fdc" data={initialData} id="download" />);

    await waitFor(() => expect(highchartsMocks.chart).toHaveBeenCalledOnce());
    view.rerender(
      <TrafficSparkline color="#2f6fdc" data={[...initialData.slice(1), 60]} id="download" />,
    );

    await waitFor(() => expect(highchartsMocks.charts[0]?.addPoint).toHaveBeenCalledOnce());
    expect(highchartsMocks.charts[0]?.addPoint).toHaveBeenCalledWith([60, 60], true, true, {
      duration: 400,
      easing: "linear",
    });
  });

  it("destroys the old chart below the sample threshold and creates a fresh relaunch chart", async () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[4, 5, 6]} id="download" />);

    await waitFor(() => expect(highchartsMocks.chart).toHaveBeenCalledOnce());
    view.rerender(<TrafficSparkline color="#2f6fdc" data={[]} id="download" />);
    await waitFor(() => expect(highchartsMocks.charts[0]?.destroy).toHaveBeenCalledOnce());
    expect(view.container.querySelector("svg")).toBeNull();

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 0, 2]} id="download" />);
    await waitFor(() => expect(highchartsMocks.chart).toHaveBeenCalledTimes(2));
    expect(highchartsMocks.charts[1]?.addPoint).not.toHaveBeenCalled();
  });

  it("reconciles interrupted sample updates and destroys the chart on unmount", async () => {
    const view = render(<TrafficSparkline color="#2f855a" data={[1, 2, 3]} id="upload" />);

    await waitFor(() => expect(highchartsMocks.chart).toHaveBeenCalledOnce());
    view.rerender(<TrafficSparkline color="#2f855a" data={[1, 2, 3, 4]} id="upload" />);
    view.rerender(<TrafficSparkline color="#2f855a" data={[1, 2, 3, 4, 5]} id="upload" />);

    await waitFor(() => expect(highchartsMocks.charts[0]?.addPoint).toHaveBeenCalledTimes(2));
    expect(highchartsMocks.chart).toHaveBeenCalledOnce();

    view.unmount();
    expect(highchartsMocks.charts[0]?.destroy).toHaveBeenCalledOnce();
  });

  it("right-aligns the initial smooth non-negative series in the 60-sample domain", async () => {
    render(<TrafficSparkline color="#2f6fdc" data={[-5, 24, 18]} id="download" />);

    await waitFor(() => expect(highchartsMocks.chart).toHaveBeenCalledOnce());
    const options = highchartsMocks.charts[0]?.options as {
      chart: { margin: number[] };
      plotOptions: { areaspline: { clip: boolean } };
      series: Array<{ data: Array<[number, number]>; type: string }>;
      xAxis: { max: number; min: number };
      yAxis: { min: number };
    };
    expect(options.series[0]?.type).toBe("areaspline");
    expect(options.series[0]?.data).toEqual([
      [57, 0],
      [58, 24],
      [59, 18],
    ]);
    expect(options.chart.margin).toEqual([1, 0, 3, 0]);
    expect(options.plotOptions.areaspline.clip).toBe(false);
    expect(options.xAxis).toMatchObject({ min: 0, max: 59 });
    expect(options.yAxis.min).toBe(0);
  });

  it("keeps the session y-axis stable until a new maximum arrives", async () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[10, 20, 15]} id="download" />);

    await waitFor(() => expect(highchartsMocks.chart).toHaveBeenCalledOnce());
    view.rerender(<TrafficSparkline color="#2f6fdc" data={[10, 20, 15, 5]} id="download" />);
    expect(highchartsMocks.charts[0]?.updateYAxis).not.toHaveBeenCalled();

    view.rerender(<TrafficSparkline color="#2f6fdc" data={[10, 20, 15, 5, 100]} id="download" />);
    await waitFor(() => expect(highchartsMocks.charts[0]?.updateYAxis).toHaveBeenCalledOnce());
    expect(highchartsMocks.charts[0]?.updateYAxis).toHaveBeenCalledWith({ max: 112 }, false);
  });

  it("animates an appended sample without recreating the chart", async () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 4, 2]} id="download" />);

    expect(view.container.querySelector(".traffic-sparkline")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    view.rerender(<TrafficSparkline color="#2f6fdc" data={[1, 4, 2, 7]} id="download" />);

    await waitFor(() => expect(highchartsMocks.charts[0]?.addPoint).toHaveBeenCalledOnce());
    expect(highchartsMocks.chart).toHaveBeenCalledOnce();
    expect(highchartsMocks.charts[0]?.addPoint).toHaveBeenCalledWith([60, 7], true, false, {
      duration: 400,
      easing: "linear",
    });
  });

  it("appends the new sample directly when reduced motion is enabled", async () => {
    mockReducedMotion(true);

    const view = render(<TrafficSparkline color="#2f855a" data={[1, 3, 2]} id="upload" />);
    view.rerender(<TrafficSparkline color="#2f855a" data={[1, 3, 2, 5]} id="upload" />);

    await waitFor(() => expect(highchartsMocks.charts[0]?.addPoint).toHaveBeenCalledOnce());
    expect(highchartsMocks.charts[0]?.addPoint).toHaveBeenCalledWith([60, 5], true, false, false);
  });

  it("renders no chart surface for an empty session series", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[]} id="upload" />);
    expect(view.container.querySelector("svg")).toBeNull();
  });
});
