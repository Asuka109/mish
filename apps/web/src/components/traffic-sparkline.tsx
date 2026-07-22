import Highcharts from "highcharts";
import { useEffect, useRef, useState } from "react";

interface TrafficSparklineProps {
  color: string;
  data: number[];
  id: string;
}

export const TRAFFIC_SPARKLINE_MAX_SAMPLES = 60;
export const TRAFFIC_SPARKLINE_MIN_SAMPLES = 3;
export const TRAFFIC_SPARKLINE_WIDTH = 360;
export const TRAFFIC_SPARKLINE_HEIGHT = 34;

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

function createHighchartsData(data: number[]): [number, number][] {
  const visibleData = data.slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES);
  const firstX = TRAFFIC_SPARKLINE_MAX_SAMPLES - visibleData.length;
  return visibleData.map((value, index) => [firstX + index, Math.max(0, value)]);
}

function isAppendedSample(previous: number[], current: number[]): boolean {
  if (current.length === previous.length + 1) {
    return previous.every((value, index) => current[index] === value);
  }
  if (
    current.length === TRAFFIC_SPARKLINE_MAX_SAMPLES &&
    previous.length === TRAFFIC_SPARKLINE_MAX_SAMPLES
  ) {
    return previous.slice(1).every((value, index) => current[index] === value);
  }
  return false;
}

function hasSameSamples(previous: number[], current: number[]): boolean {
  return (
    previous.length === current.length && previous.every((value, index) => current[index] === value)
  );
}

function paddedMaximum(data: number[]): number {
  return Math.max(1, Math.round(Math.max(1, ...data.map((value) => Math.max(0, value))) * 1.12));
}

export function TrafficSparkline({ color, data, id }: TrafficSparklineProps) {
  const reducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Highcharts.Chart | null>(null);
  const previousDataRef = useRef<number[]>([]);
  const latestXRef = useRef(TRAFFIC_SPARKLINE_MAX_SAMPLES - 1);
  const sessionMaximumRef = useRef(1);

  useEffect(() => {
    if (data.length < TRAFFIC_SPARKLINE_MIN_SAMPLES) {
      chartRef.current?.destroy();
      chartRef.current = null;
      previousDataRef.current = data;
      latestXRef.current = TRAFFIC_SPARKLINE_MAX_SAMPLES - 1;
      sessionMaximumRef.current = 1;
      return;
    }

    const visibleData = data.slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES);
    const chartData = createHighchartsData(visibleData);
    const container = containerRef.current;
    if (!container) return;

    if (!chartRef.current) {
      sessionMaximumRef.current = paddedMaximum(visibleData);
      latestXRef.current = TRAFFIC_SPARKLINE_MAX_SAMPLES - 1;
      chartRef.current = Highcharts.chart(container, {
        accessibility: { enabled: false },
        chart: {
          animation: false,
          backgroundColor: "transparent",
          height: TRAFFIC_SPARKLINE_HEIGHT,
          margin: [1, 0, 1, 0],
          reflow: false,
          spacing: [0, 0, 0, 0],
          type: "areaspline",
          width: TRAFFIC_SPARKLINE_WIDTH,
        },
        credits: { enabled: false },
        legend: { enabled: false },
        plotOptions: {
          areaspline: {
            animation: false,
            enableMouseTracking: false,
            fillOpacity: 0,
            lineWidth: 1.35,
            marker: { enabled: false },
            states: { hover: { enabled: false }, inactive: { enabled: false } },
            threshold: 0,
          },
        },
        series: [{ animation: false, color, data: chartData, type: "areaspline" }],
        title: { text: undefined },
        tooltip: { enabled: false },
        xAxis: {
          endOnTick: false,
          max: TRAFFIC_SPARKLINE_MAX_SAMPLES - 1,
          min: 0,
          startOnTick: false,
          visible: false,
        },
        yAxis: {
          endOnTick: false,
          max: sessionMaximumRef.current,
          min: 0,
          startOnTick: false,
          title: { text: undefined },
          visible: false,
        },
      });
      previousDataRef.current = visibleData;
      return;
    }

    const previousData = previousDataRef.current;
    const chart = chartRef.current;
    if (hasSameSamples(previousData, visibleData)) return;
    if (isAppendedSample(previousData, visibleData)) {
      const latestValue = Math.max(0, visibleData.at(-1) ?? 0);
      const nextX = latestXRef.current + 1;
      const nextMaximum = paddedMaximum([latestValue]);
      if (nextMaximum > sessionMaximumRef.current) {
        sessionMaximumRef.current = nextMaximum;
        chart.yAxis[0]?.update({ max: nextMaximum }, false);
      }
      chart.xAxis[0]?.setExtremes(nextX - (TRAFFIC_SPARKLINE_MAX_SAMPLES - 1), nextX, false, false);
      chart.series[0]?.addPoint(
        [nextX, latestValue],
        true,
        previousData.length >= TRAFFIC_SPARKLINE_MAX_SAMPLES,
        reducedMotion ? false : { duration: 400, easing: "linear" },
      );
      latestXRef.current = nextX;
    } else {
      sessionMaximumRef.current = paddedMaximum(visibleData);
      latestXRef.current = TRAFFIC_SPARKLINE_MAX_SAMPLES - 1;
      chart.yAxis[0]?.update({ max: sessionMaximumRef.current }, false);
      chart.xAxis[0]?.setExtremes(0, TRAFFIC_SPARKLINE_MAX_SAMPLES - 1, false, false);
      chart.series[0]?.setData(chartData, true, false, false);
    }
    previousDataRef.current = visibleData;
  }, [color, data, reducedMotion]);

  useEffect(
    () => () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    },
    [],
  );

  return (
    <div ref={containerRef} aria-hidden="true" className="traffic-sparkline" data-series={id} />
  );
}
