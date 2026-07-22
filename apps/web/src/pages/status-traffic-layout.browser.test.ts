import { page } from "vitest/browser";
import { beforeAll, describe, expect, test, vi } from "vitest";

interface TrafficRowGeometry {
  label: DOMRect;
  rate: DOMRect;
  sparkline: HTMLElement;
  sparklineRect: DOMRect;
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function navigateToStatus(): Promise<void> {
  window.history.pushState({}, "", "/status");
  window.dispatchEvent(new PopStateEvent("popstate"));

  await vi.waitFor(() => {
    expect(document.querySelectorAll(".traffic-session-row")).toHaveLength(2);
  });
  await nextFrame();
}

function trafficRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".traffic-session-row")];
}

function trafficPair(): HTMLElement {
  const pair = document.querySelector<HTMLElement>(".traffic-session-pair");
  if (!pair) throw new Error("Traffic session pair is missing");
  return pair;
}

function measure(row: HTMLElement): TrafficRowGeometry {
  const label = row.querySelector<HTMLElement>(".traffic-session-label");
  const rate = row.querySelector<HTMLElement>(".traffic-rate-value");
  const sparkline = row.querySelector<HTMLElement>(".traffic-sparkline");

  if (!label || !rate || !sparkline) {
    throw new Error("Traffic row is missing a label, rate, or sparkline");
  }

  return {
    label: label.getBoundingClientRect(),
    rate: rate.getBoundingClientRect(),
    sparkline,
    sparklineRect: sparkline.getBoundingClientRect(),
  };
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await import("../main");
  await navigateToStatus();
});

describe("status traffic row layout", () => {
  test("uses one stable three-column grid for both traffic rows", async () => {
    await page.viewport(1024, 720);
    await nextFrame();

    const measurements = trafficRows().map(measure);
    for (const row of trafficRows()) {
      expect(
        [...row.children].map((child) => child.className),
        "reading order keeps the rate beside the cumulative total",
      ).toEqual(["traffic-session-label", "traffic-rate-value tabular", "traffic-sparkline"]);

      const { label, rate, sparklineRect } = measure(row);
      expect(rate.left, "rate follows the label").toBeGreaterThanOrEqual(label.right);
      expect(sparklineRect.left, "sparkline follows the rate").toBeGreaterThanOrEqual(rate.right);
      expect(Math.abs(rate.top + rate.height / 2 - (label.top + label.height / 2))).toBeLessThan(1);
      expect(sparklineRect.width, "sparkline receives the remaining row width").toBeGreaterThan(72);
    }
    expect(measurements[0].label.left).toBe(measurements[1].label.left);
    expect(measurements[0].label.width).toBe(measurements[1].label.width);
    expect(measurements[0].rate.left).toBe(measurements[1].rate.left);
    expect(measurements[0].rate.width).toBe(measurements[1].rate.width);
    expect(measurements[0].sparklineRect.left).toBe(measurements[1].sparklineRect.left);
    expect(measurements[0].sparklineRect.width).toBe(measurements[1].sparklineRect.width);
  });

  test("keeps the curve track fixed for longer rates and uses one continuous row divider", async () => {
    await page.viewport(1024, 720);
    await nextFrame();
    const before = trafficRows().map(measure);
    for (const row of trafficRows()) {
      const rate = row.querySelector<HTMLElement>(".traffic-rate-value");
      if (!rate) throw new Error("Traffic row is missing its rate");
      rate.textContent = "999.99 MB/s";
    }
    await nextFrame();
    const after = trafficRows().map(measure);
    for (const [index, row] of after.entries()) {
      expect(row.sparklineRect.left).toBe(before[index].sparklineRect.left);
      expect(row.sparklineRect.width).toBe(before[index].sparklineRect.width);
    }
    const pair = trafficPair();
    const divider = getComputedStyle(pair, "::after");
    expect(divider.position).toBe("absolute");
    expect(divider.left).toBe("0px");
    expect(divider.right).toBe("0px");
    expect(divider.height).toBe("1px");
  });

  test("keeps paired columns aligned in the compact layout while hiding the graph", async () => {
    await page.viewport(360, 720);
    await nextFrame();

    const measurements = trafficRows().map(measure);
    for (const row of trafficRows()) {
      const { label, rate, sparkline } = measure(row);
      expect(rate.left, "rate remains beside the label").toBeGreaterThanOrEqual(label.right);
      expect(Math.abs(rate.top + rate.height / 2 - (label.top + label.height / 2))).toBeLessThan(1);
      expect(getComputedStyle(sparkline).display).toBe("none");
    }
    expect(getComputedStyle(trafficPair()).gridTemplateColumns).toMatch(/^\S+ 112px$/);
    expect(measurements[0].label.left).toBe(measurements[1].label.left);
    expect(measurements[0].rate.left).toBe(measurements[1].rate.left);
    expect(measurements[0].rate.width).toBe(measurements[1].rate.width);
  });
});
