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
  test("places each live rate immediately after its cumulative total before the sparkline", async () => {
    await page.viewport(1024, 720);
    await nextFrame();

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
  });

  test("keeps the total and rate together when the compact rule hides the graph", async () => {
    await page.viewport(360, 720);
    await nextFrame();

    for (const row of trafficRows()) {
      const { label, rate, sparkline } = measure(row);
      expect(rate.left, "rate remains beside the label").toBeGreaterThanOrEqual(label.right);
      expect(Math.abs(rate.top + rate.height / 2 - (label.top + label.height / 2))).toBeLessThan(1);
      expect(getComputedStyle(row).gridTemplateColumns).not.toContain("72px");
      expect(getComputedStyle(sparkline).display).toBe("none");
    }
  });
});
