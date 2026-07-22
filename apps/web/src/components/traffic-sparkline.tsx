import {
  Chart,
  Filler,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  type ChartConfiguration,
} from "chart.js";
import { useEffect, useRef, useState } from "react";

Chart.register(LineController, LineElement, PointElement, LinearScale, Filler);

interface TrafficSparklineProps {
  color: string;
  data: number[];
  id: string;
}

export const TRAFFIC_SPARKLINE_MAX_SAMPLES = 60;

function resolveColor(canvas: HTMLCanvasElement, color: string) {
  const variable = color.match(/^var\((--[^)]+)\)$/)?.[1];
  return variable ? getComputedStyle(canvas).getPropertyValue(variable).trim() : color;
}

export function createTrafficSparklineConfig(
  color: string,
  data: number[],
  reducedMotion: boolean,
): ChartConfiguration<"line", number[], string> {
  const samples = data.slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES);
  return {
    type: "line",
    data: {
      labels: samples.map((_, index) => String(index)),
      datasets: [
        {
          backgroundColor: (context) => {
            const { chart } = context;
            const gradient = chart.ctx.createLinearGradient(
              0,
              chart.chartArea.top,
              0,
              chart.chartArea.bottom,
            );
            gradient.addColorStop(0, color);
            gradient.addColorStop(1, "transparent");
            return gradient;
          },
          borderColor: color,
          borderWidth: 1.35,
          cubicInterpolationMode: "monotone",
          data: samples,
          fill: "start",
          pointHitRadius: 0,
          pointHoverRadius: 0,
          pointRadius: 0,
        },
      ],
    },
    options: {
      animation: reducedMotion ? false : { duration: 180, easing: "easeOutQuart" },
      events: [],
      interaction: { intersect: false },
      maintainAspectRatio: false,
      normalized: true,
      parsing: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      responsive: true,
      scales: {
        x: { display: false, grid: { display: false }, ticks: { display: false } },
        y: {
          beginAtZero: true,
          display: false,
          grid: { display: false },
          ticks: { display: false },
        },
      },
    },
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
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<Chart<"line", number[], string> | null>(null);
  const reducedMotion = useReducedMotion();
  const samples = data.slice(-TRAFFIC_SPARKLINE_MAX_SAMPLES);
  const sampleKey = samples.join(",");

  useEffect(() => {
    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    if (samples.length === 0) {
      chart.current?.destroy();
      chart.current = null;
      return;
    }
    const config = createTrafficSparklineConfig(
      resolveColor(target, color),
      samples,
      reducedMotion,
    );
    if (!chart.current) {
      chart.current = new Chart(target, config);
      return;
    }
    const instance = chart.current;
    instance.stop();
    instance.data = config.data;
    instance.options = config.options ?? {};
    instance.update(reducedMotion ? "none" : undefined);
  }, [color, reducedMotion, sampleKey]);

  return (
    <div aria-hidden="true" className="traffic-sparkline">
      <canvas data-sparkline-id={id} hidden={samples.length === 0} ref={canvas} />
    </div>
  );
}
