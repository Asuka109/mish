import { ResponsiveLine } from "@nivo/line";
import { useEffect, useState } from "react";

interface TrafficSparklineProps {
  color: string;
  data: number[];
  id: string;
}

export const TRAFFIC_SPARKLINE_MAX_SAMPLES = 60;

interface TrafficSparklineSeries {
  data: Array<{ x: number; y: number }>;
  id: string;
}

export function createTrafficSparklineData(id: string, data: number[]): TrafficSparklineSeries[] {
  return [
    {
      data: data
        .slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES)
        .map((value, index) => ({ x: index, y: value })),
      id,
    },
  ];
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function TrafficSparkline({ color, data, id }: TrafficSparklineProps) {
  const reducedMotion = useReducedMotion();
  const chartData = createTrafficSparklineData(id, data);
  if (chartData[0].data.length === 0)
    return <div aria-hidden="true" className="traffic-sparkline" />;

  return (
    <div aria-hidden="true" className="traffic-sparkline">
      <ResponsiveLine
        animate={!reducedMotion}
        axisBottom={null}
        axisLeft={null}
        colors={[color]}
        curve="monotoneX"
        data={chartData}
        enableArea
        enableGridX={false}
        enableGridY={false}
        enablePoints={false}
        isInteractive={false}
        lineWidth={1.35}
        margin={{ bottom: 2, left: 2, right: 2, top: 2 }}
        motionConfig="gentle"
        theme={{ crosshair: { line: { stroke: "transparent" } } }}
        xScale={{ max: TRAFFIC_SPARKLINE_MAX_SAMPLES - 1, min: 0, type: "linear" }}
        yScale={{ stacked: false, type: "linear" }}
      />
    </div>
  );
}
