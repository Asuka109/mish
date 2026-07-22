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
    expect(document.querySelectorAll(".traffic-session-column")).toHaveLength(3);
  });
  await nextFrame();
}

function trafficPair(): HTMLElement {
  const pair = document.querySelector<HTMLElement>(".traffic-session-pair");
  if (!pair) throw new Error("Traffic session pair is missing");
  return pair;
}

function sessionList(): HTMLElement {
  const list = document.querySelector<HTMLElement>(".session-list");
  if (!list) throw new Error("Session list is missing");
  return list;
}

function trafficColumns(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".traffic-session-column")];
}

function measure(index: number): TrafficRowGeometry {
  const label = document.querySelectorAll<HTMLElement>(".traffic-session-label")[index];
  const rate = document.querySelectorAll<HTMLElement>(".traffic-rate-value")[index];
  const sparkline = document.querySelectorAll<HTMLElement>(".traffic-sparkline")[index];
  if (!label || !rate || !sparkline) throw new Error("Traffic row is incomplete");
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
  test("uses a wrapping flex session container without grid semantics", async () => {
    await page.viewport(1024, 720);
    await nextFrame();

    const list = sessionList();
    const pair = trafficPair();
    const metrics = [...list.querySelectorAll<HTMLElement>(".session-metric")];
    expect(list.classList.contains("section-grid")).toBe(false);
    expect(getComputedStyle(list).display).toBe("flex");
    expect(getComputedStyle(list).flexWrap).toBe("wrap");
    expect(Math.abs(pair.getBoundingClientRect().width - list.clientWidth)).toBeLessThan(1);
    expect(metrics).toHaveLength(4);
    expect(metrics[0]?.getBoundingClientRect().left).toBe(metrics[2]?.getBoundingClientRect().left);
    expect(metrics[1]?.getBoundingClientRect().left).toBe(metrics[3]?.getBoundingClientRect().left);
    expect(metrics[0]?.getBoundingClientRect().width).toBe(
      metrics[1]?.getBoundingClientRect().width,
    );
  });

  test("uses three horizontal flex columns with matching top and bottom rows", async () => {
    await page.viewport(1024, 720);
    await nextFrame();

    const columns = trafficColumns();
    expect(getComputedStyle(trafficPair()).display).toBe("flex");
    expect(getComputedStyle(trafficPair()).gap).toBe("12px");
    expect(getComputedStyle(columns[0]).flexGrow).toBe("0");
    expect(getComputedStyle(columns[1]).flexGrow).toBe("0");
    expect(getComputedStyle(columns[2]).flexGrow).toBe("1");
    for (const column of columns) {
      expect(getComputedStyle(column).display).toBe("flex");
      expect(getComputedStyle(column).flexDirection).toBe("column");
    }

    const download = measure(0);
    const upload = measure(1);
    expect(download.label.left).toBe(upload.label.left);
    expect(download.rate.left).toBe(upload.rate.left);
    expect(download.sparklineRect.left).toBe(upload.sparklineRect.left);
    expect(download.sparklineRect.width).toBe(upload.sparklineRect.width);
    expect(Math.abs(download.label.top - download.rate.top)).toBeLessThan(1);
    expect(Math.abs(upload.label.top - upload.rate.top)).toBeLessThan(1);
  });

  test("keeps the curve column fixed for longer rates and uses one continuous row divider", async () => {
    await page.viewport(1024, 720);
    await nextFrame();
    const before = [measure(0), measure(1)];
    for (const rate of document.querySelectorAll<HTMLElement>(".traffic-rate-value")) {
      rate.textContent = "999.99 MB/s";
    }
    await nextFrame();
    for (const [index, after] of [measure(0), measure(1)].entries()) {
      expect(after.sparklineRect.left).toBe(before[index].sparklineRect.left);
      expect(after.sparklineRect.width).toBe(before[index].sparklineRect.width);
    }
    const divider = getComputedStyle(trafficPair(), "::after");
    expect(divider.position).toBe("absolute");
    expect(divider.left).toBe("0px");
    expect(divider.right).toBe("0px");
    expect(divider.height).toBe("1px");
  });

  test("right-aligns a fixed-width chart stack and clips only its older left history", async () => {
    await page.viewport(1024, 720);
    await nextFrame();

    const [summary, rate, curve] = trafficColumns();
    const stack = curve.querySelector<HTMLElement>(".traffic-session-chart-stack");
    if (!stack) throw new Error("Traffic chart stack is missing");
    expect(getComputedStyle(summary).flexGrow).toBe("0");
    expect(getComputedStyle(rate).flexGrow).toBe("0");
    expect(getComputedStyle(curve).overflowX).toBe("hidden");
    const maskImage = getComputedStyle(curve).maskImage;
    expect(maskImage).toContain("linear-gradient");
    expect(maskImage.match(/32px/g)).toHaveLength(2);
    expect(stack.getBoundingClientRect().right).toBe(curve.getBoundingClientRect().right);
    expect(stack.getBoundingClientRect().width).toBe(360);
  });

  test("keeps the fixed-width chart stack clipped instead of hiding it in the compact layout", async () => {
    await page.viewport(360, 720);
    await nextFrame();

    const [summary, rate, curve] = trafficColumns();
    expect(getComputedStyle(summary).flexGrow).toBe("0");
    expect(getComputedStyle(rate).flexGrow).toBe("0");
    expect(getComputedStyle(curve).display).toBe("flex");
    expect(getComputedStyle(curve).overflowX).toBe("hidden");
    expect(curve.getBoundingClientRect().width).toBeLessThan(360);
  });
});
