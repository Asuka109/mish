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

describe("TrafficSparkline SVG integration", () => {
  test("waits for three samples, then appends at the right edge on one persistent SVG", async () => {
    await renderSparkline([1, 2]);
    expect(container.querySelector("svg")).toBeNull();

    await renderSparkline([1, 2, 3]);
    const surface = container.querySelector("svg");
    const line = container.querySelector("path[stroke]");
    expect(surface).not.toBeNull();
    expect(line).toHaveAttribute("stroke-width", "1.35");
    expect(surface).toHaveAttribute("viewBox", "0 0 360 34");
    expect(container.querySelector("mask")).not.toBeNull();

    await renderSparkline([1, 2, 3, 4]);
    expect(container.querySelector("svg")).toBe(surface);
    expect(container.querySelector("path[stroke]")).not.toBeNull();
  });

  test("removes the drawing during stop and renders a new one after relaunch", async () => {
    await renderSparkline([2, 3, 4]);
    const firstSurface = container.querySelector("svg");

    await renderSparkline([]);
    expect(container.querySelector("svg")).toBeNull();

    await renderSparkline([0, 1, 2]);
    expect(container.querySelector("svg")).not.toBe(firstSurface);
  });
});
