import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { TrafficSparkline } from "./traffic-sparkline";

let container: HTMLDivElement;
let root: Root;

async function renderSparkline(data: number[]): Promise<void> {
  root.render(<TrafficSparkline color="#2f6fdc" data={data} />);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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

describe("TrafficSparkline Recharts integration", () => {
  test("waits for three samples, then keeps one chart surface while appending", async () => {
    await renderSparkline([1, 2]);
    expect(container.querySelector("svg")).toBeNull();

    await renderSparkline([1, 2, 3]);
    const surface = container.querySelector(".recharts-surface");
    expect(surface).not.toBeNull();
    expect(container.querySelector(".recharts-area-area")).not.toBeNull();
    expect(container.querySelector(".recharts-area-curve")).not.toBeNull();

    await renderSparkline([1, 2, 3, 4]);
    expect(container.querySelector(".recharts-surface")).toBe(surface);
  });

  test("removes the chart during stop and creates a fresh one after relaunch", async () => {
    await renderSparkline([2, 3, 4]);
    const firstSurface = container.querySelector(".recharts-surface");

    await renderSparkline([]);
    expect(container.querySelector("svg")).toBeNull();

    await renderSparkline([0, 1, 2]);
    expect(container.querySelector(".recharts-surface")).not.toBe(firstSurface);
  });
});
