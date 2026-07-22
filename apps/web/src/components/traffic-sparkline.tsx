import { curveMonotoneX, line } from "d3-shape";
import { useEffect, useId, useState } from "react";

interface TrafficSparklineProps {
  color: string;
  data: number[];
  id: string;
}

export const TRAFFIC_SPARKLINE_MAX_SAMPLES = 60;
export const TRAFFIC_SPARKLINE_WIDTH = 360;
export const TRAFFIC_SPARKLINE_HEIGHT = 34;

const HORIZONTAL_INSET = 12;
const VERTICAL_INSET = 2;

interface TrafficSparklineDatum {
  x: number;
  y: number;
}

interface TrafficSparklineSeries {
  data: TrafficSparklineDatum[];
  id: string;
}

interface TrafficSparklineGeometry {
  path: string;
  points: TrafficSparklineDatum[];
  tailStartX: number | null;
}

export function createTrafficSparklineData(id: string, data: number[]): TrafficSparklineSeries[] {
  const visibleData = data.slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES);
  const firstX = TRAFFIC_SPARKLINE_MAX_SAMPLES - visibleData.length;

  return [
    {
      data: visibleData.map((value, index) => ({ x: firstX + index, y: Math.max(0, value) })),
      id,
    },
  ];
}

export function createTrafficSparklineGeometry(data: number[]): TrafficSparklineGeometry {
  const values = createTrafficSparklineData("sparkline", data)[0].data;
  if (values.length === 0) return { path: "", points: [], tailStartX: null };

  const maximum = Math.max(1, ...values.map(({ y }) => y));
  const drawableWidth = TRAFFIC_SPARKLINE_WIDTH - HORIZONTAL_INSET * 2;
  const drawableHeight = TRAFFIC_SPARKLINE_HEIGHT - VERTICAL_INSET * 2;
  const points = values.map(({ x, y }) => ({
    x: HORIZONTAL_INSET + (x / (TRAFFIC_SPARKLINE_MAX_SAMPLES - 1)) * drawableWidth,
    y: TRAFFIC_SPARKLINE_HEIGHT - VERTICAL_INSET - (y / maximum) * drawableHeight,
  }));
  const path =
    line<TrafficSparklineDatum>()
      .x(({ x }) => x)
      .y(({ y }) => y)
      .curve(curveMonotoneX)(points) ?? "";

  return {
    path,
    points,
    tailStartX: points.length > 1 ? (points.at(-2)?.x ?? null) : null,
  };
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
  const reactId = useId().replaceAll(":", "");
  const geometry = createTrafficSparklineGeometry(data);
  if (geometry.points.length === 0) return <div aria-hidden="true" className="traffic-sparkline" />;

  const latestPoint = geometry.points.at(-1);
  const tailKey = `${geometry.points.length}-${data.at(-2) ?? "start"}-${data.at(-1)}`;
  const baseClipId = `traffic-sparkline-base-${reactId}`;
  const tailClipId = `traffic-sparkline-tail-${reactId}`;
  const tailStartX = geometry.tailStartX;

  return (
    <div aria-hidden="true" className="traffic-sparkline" data-series={id}>
      <svg
        className="traffic-sparkline-svg"
        preserveAspectRatio="none"
        viewBox={`0 0 ${TRAFFIC_SPARKLINE_WIDTH} ${TRAFFIC_SPARKLINE_HEIGHT}`}
      >
        {tailStartX === null ? (
          latestPoint ? (
            <circle cx={latestPoint.x} cy={latestPoint.y} fill={color} r="1" />
          ) : null
        ) : (
          <>
            <defs>
              <clipPath id={baseClipId}>
                <rect height={TRAFFIC_SPARKLINE_HEIGHT} width={tailStartX} x="0" y="0" />
              </clipPath>
              <clipPath id={tailClipId}>
                <rect
                  className={
                    reducedMotion
                      ? "traffic-sparkline-tail-clip"
                      : "traffic-sparkline-tail-clip is-animated"
                  }
                  height={TRAFFIC_SPARKLINE_HEIGHT}
                  width={TRAFFIC_SPARKLINE_WIDTH - tailStartX}
                  x={tailStartX}
                  y="0"
                />
              </clipPath>
            </defs>
            <path
              className="traffic-sparkline-line"
              clipPath={`url(#${baseClipId})`}
              d={geometry.path}
              stroke={color}
            />
            <path
              key={tailKey}
              className="traffic-sparkline-line traffic-sparkline-tail"
              clipPath={`url(#${tailClipId})`}
              d={geometry.path}
              stroke={color}
            />
          </>
        )}
      </svg>
    </div>
  );
}
