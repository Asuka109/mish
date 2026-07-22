import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@nivo/line", () => ({
  ResponsiveLine: ({
    animate,
    curve,
    data,
  }: {
    animate: boolean;
    curve: string;
    data: unknown[];
  }) => <div data-animate={String(animate)} data-curve={curve} data-points={data.length} />,
}));

import {
  createTrafficSparklineData,
  TRAFFIC_SPARKLINE_MAX_SAMPLES,
  TrafficSparkline,
} from "./traffic-sparkline";

describe("TrafficSparkline", () => {
  it("uses Nivo's monotone line data with a strict 60-sample window", () => {
    const data = createTrafficSparklineData(
      "download",
      Array.from({ length: 64 }, (_, index) => index),
    );

    expect(data[0].data).toHaveLength(TRAFFIC_SPARKLINE_MAX_SAMPLES);
    expect(data[0].data[0]).toMatchObject({ x: 0, y: 4 });
  });

  it("enables Nivo motion normally and renders the sparkline as decorative", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[1, 4, 2]} id="download" />);

    expect(view.container.querySelector(".traffic-sparkline")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(view.container.querySelector("[data-curve]")).toHaveAttribute("data-curve", "monotoneX");
  });

  it("renders no chart surface for an empty session series", () => {
    const view = render(<TrafficSparkline color="#2f6fdc" data={[]} id="upload" />);
    expect(view.container.querySelector("[data-curve]")).toBeNull();
  });
});
