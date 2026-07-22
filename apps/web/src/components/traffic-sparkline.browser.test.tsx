import Highcharts from "highcharts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TrafficSparkline } from "./traffic-sparkline";

let container: HTMLDivElement;
let root: Root;

async function renderSparkline(data: number[]): Promise<void> {
  root.render(<TrafficSparkline color="#2f6fdc" data={data} id="download" />);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function renderedChart(): Highcharts.Chart | undefined {
  const chartContainer = container.querySelector<HTMLElement>("[data-highcharts-chart]");
  if (!chartContainer) return undefined;
  return Highcharts.charts[Number(chartContainer.dataset.highchartsChart)];
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

describe("TrafficSparkline Highcharts integration", () => {
  test("waits for three samples, then appends at the right edge on one persistent chart", async () => {
    await renderSparkline([1, 2]);
    expect(renderedChart()).toBeUndefined();

    await renderSparkline([1, 2, 3]);
    await vi.waitFor(() => expect(renderedChart()).toBeDefined());
    const chart = renderedChart();
    expect(chart?.series[0]?.data.map(({ x }) => x)).toEqual([57, 58, 59]);
    expect(container.querySelector(".highcharts-graph")).not.toBeNull();

    await renderSparkline([1, 2, 3, 4]);
    await vi.waitFor(() => expect(chart?.series[0]?.data).toHaveLength(4));
    expect(renderedChart()).toBe(chart);
    expect(chart?.series[0]?.data.at(-1)?.x).toBe(60);
  });

  test("destroys the prior chart across stop and creates a fresh relaunch chart", async () => {
    await renderSparkline([2, 3, 4]);
    await vi.waitFor(() => expect(renderedChart()).toBeDefined());
    const firstChart = renderedChart();

    await renderSparkline([]);
    await vi.waitFor(() => expect(container.querySelector("svg")).toBeNull());
    expect(Highcharts.charts).not.toContain(firstChart);

    await renderSparkline([0, 1, 2]);
    await vi.waitFor(() => expect(renderedChart()).toBeDefined());
    expect(renderedChart()).not.toBe(firstChart);
  });
});
