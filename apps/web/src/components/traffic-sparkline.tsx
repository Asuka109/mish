import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, matchAppend, XAxis, YAxis } from "recharts";
import { cx, tv } from "@mish/ui/tv";

interface TrafficSparklineProps {
  color: string;
  data: number[];
}

interface TrafficSample {
  value: number;
  x: number;
}

export const TRAFFIC_SPARKLINE_MAX_SAMPLES = 60;
export const TRAFFIC_SPARKLINE_MIN_SAMPLES = 3;
export const TRAFFIC_SPARKLINE_WIDTH = 360;
export const TRAFFIC_SPARKLINE_HEIGHT = 34;

const trafficSparklineStyles = tv({
  base: cx(
    "traffic-sparkline h-8.5 w-90 grow-0 shrink-0 basis-90 self-center overflow-hidden opacity-82",
    "[mask-image:radial-gradient(ellipse_72%_88%_at_center,black_50%,transparent_100%)]",
    "[&_.recharts-surface]:size-full [&_.recharts-wrapper]:!size-full",
  ),
});

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

export function sanitizeTrafficSamples(data: number[]): number[] {
  return data
    .slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES)
    .map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
}

export function createTrafficSamples(data: number[]): TrafficSample[] {
  const firstX = TRAFFIC_SPARKLINE_MAX_SAMPLES - data.length;
  return data.map((value, index) => ({ value, x: firstX + index }));
}

function paddedMaximum(data: number[]): number {
  return Math.max(1, Math.round(Math.max(1, ...data) * 1.12));
}

function useSessionMaximum(data: number[], active: boolean): number {
  const activeRef = useRef(false);
  const maximumRef = useRef(1);
  if (!active) {
    activeRef.current = false;
    maximumRef.current = 1;
    return 1;
  }
  if (!activeRef.current) maximumRef.current = paddedMaximum(data);
  else maximumRef.current = Math.max(maximumRef.current, paddedMaximum(data));
  activeRef.current = true;
  return maximumRef.current;
}

export function TrafficSparkline({ color, data }: TrafficSparklineProps) {
  const reducedMotion = useReducedMotion();
  const visibleData = sanitizeTrafficSamples(data);
  const active = visibleData.length >= TRAFFIC_SPARKLINE_MIN_SAMPLES;
  const maximum = useSessionMaximum(visibleData, active);

  return (
    <div
      aria-hidden="true"
      className={trafficSparklineStyles()}
      data-reduced-motion={reducedMotion || undefined}
    >
      {active ? (
        <AreaChart
          data={createTrafficSamples(visibleData)}
          height={TRAFFIC_SPARKLINE_HEIGHT}
          margin={{ bottom: 3, left: 0, right: 0, top: 1 }}
          width={TRAFFIC_SPARKLINE_WIDTH}
        >
          <XAxis
            allowDataOverflow
            axisLine={false}
            dataKey="x"
            domain={[0, TRAFFIC_SPARKLINE_MAX_SAMPLES - 1]}
            hide
            tickLine={false}
            type="number"
          />
          <YAxis
            allowDataOverflow
            axisLine={false}
            domain={[0, maximum]}
            hide
            tickLine={false}
            type="number"
          />
          <Area
            activeDot={false}
            animationDuration={400}
            animationEasing="linear"
            animationMatchBy={matchAppend}
            baseValue={0}
            dataKey="value"
            dot={false}
            fill={color}
            fillOpacity={0.08}
            isAnimationActive={!reducedMotion}
            stroke={color}
            strokeWidth={1.35}
            type="monotone"
          />
        </AreaChart>
      ) : null}
    </div>
  );
}
