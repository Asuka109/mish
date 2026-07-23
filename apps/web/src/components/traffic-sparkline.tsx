import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cx, tv } from "@mish/ui/tv";

interface TrafficSparklineProps {
  color: string;
  data: number[];
}

interface Point {
  x: number;
  y: number;
}

interface SparklineGeometry {
  area: string;
  line: string;
}

export const TRAFFIC_SPARKLINE_MAX_SAMPLES = 60;
export const TRAFFIC_SPARKLINE_MIN_SAMPLES = 3;
export const TRAFFIC_SPARKLINE_WIDTH = 360;
export const TRAFFIC_SPARKLINE_HEIGHT = 34;

const animationDuration = 400;
const trafficSparklineStyles = tv({
  base: cx(
    "traffic-sparkline h-8.5 w-90 grow-0 shrink-0 basis-90 self-center opacity-82",
    "[&>svg]:block [&>svg]:size-full [&>svg]:outline-none",
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
  return Math.max(1, Math.round(Math.max(1, ...data) * 1.12));
}

function pointsForSamples(data: number[], maximum: number): Point[] {
  const firstX = TRAFFIC_SPARKLINE_MAX_SAMPLES - data.length;
  return data.map((value, index) => ({
    x: ((firstX + index) / (TRAFFIC_SPARKLINE_MAX_SAMPLES - 1)) * TRAFFIC_SPARKLINE_WIDTH,
    y: TRAFFIC_SPARKLINE_HEIGHT - (value / maximum) * TRAFFIC_SPARKLINE_HEIGHT,
  }));
}

function appendStartPoints(previous: number[], maximum: number): Point[] {
  const points = pointsForSamples(previous, maximum);
  const lastY = points.at(-1)?.y ?? TRAFFIC_SPARKLINE_HEIGHT;
  return [...points, { x: TRAFFIC_SPARKLINE_WIDTH, y: lastY }];
}

function smoothPath(points: Point[]): string {
  const first = points[0];
  if (!first) return "";
  if (points.length === 1) return `M ${first.x} ${first.y}`;
  let path = `M ${first.x} ${first.y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (!current || !next) continue;
    const previous = points[index - 1] ?? current;
    const afterNext = points[index + 2] ?? next;
    path += ` C ${current.x + (next.x - previous.x) / 6} ${current.y + (next.y - previous.y) / 6}, ${next.x - (afterNext.x - current.x) / 6} ${next.y - (afterNext.y - current.y) / 6}, ${next.x} ${next.y}`;
  }
  return path;
}

function geometryFromPoints(points: Point[]): SparklineGeometry {
  const line = smoothPath(points);
  const firstX = points[0]?.x ?? 0;
  return {
    area: `${line} L ${TRAFFIC_SPARKLINE_WIDTH} ${TRAFFIC_SPARKLINE_HEIGHT} L ${firstX} ${TRAFFIC_SPARKLINE_HEIGHT} Z`,
    line,
  };
}

export function createSparklineGeometry(data: number[], maximum: number): SparklineGeometry {
  return geometryFromPoints(pointsForSamples(data, maximum));
}

function interpolatePoints(start: Point[], end: Point[], progress: number): Point[] {
  return end.map((point, index) => {
    const initial = start[index] ?? point;
    return {
      x: initial.x + (point.x - initial.x) * progress,
      y: initial.y + (point.y - initial.y) * progress,
    };
  });
}

export function TrafficSparkline({ color, data }: TrafficSparklineProps) {
  const reducedMotion = useReducedMotion();
  const fadeId = useId().replaceAll(":", "");
  const maskId = `traffic-sparkline-mask-${fadeId}`;
  const visibleData = useMemo(() => sanitizeTrafficSamples(data), [data]);
  const previousDataRef = useRef<number[]>(visibleData);
  const maximumRef = useRef(paddedMaximum(visibleData));
  const animationFrameRef = useRef<number | null>(null);
  const [geometry, setGeometry] = useState(() =>
    createSparklineGeometry(visibleData, maximumRef.current),
  );

  useEffect(() => {
    const previous = previousDataRef.current;
    const previousMaximum = maximumRef.current;
    const reset = visibleData.length < TRAFFIC_SPARKLINE_MIN_SAMPLES;
    const unchanged = hasSameSamples(previous, visibleData);
    const appended = !reset && isAppendedSample(previous, visibleData);
    previousDataRef.current = visibleData;

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (reset) {
      maximumRef.current = 1;
      setGeometry(createSparklineGeometry(visibleData, 1));
      return;
    }
    if (unchanged) return;

    const nextMaximum = Math.max(previousMaximum, paddedMaximum(visibleData));
    maximumRef.current = nextMaximum;
    const target = createSparklineGeometry(visibleData, nextMaximum);
    if (!appended || reducedMotion) {
      setGeometry(target);
      return;
    }

    const start = appendStartPoints(previous, previousMaximum);
    const end = pointsForSamples(visibleData, nextMaximum);
    const startedAt = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / animationDuration);
      const eased = 1 - (1 - progress) ** 3;
      setGeometry(geometryFromPoints(interpolatePoints(start, end, eased)));
      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
        return;
      }
      animationFrameRef.current = null;
    };
    setGeometry(geometryFromPoints(start));
    animationFrameRef.current = requestAnimationFrame(animate);
  }, [reducedMotion, visibleData]);

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    },
    [],
  );

  return (
    <div aria-hidden="true" className={trafficSparklineStyles()}>
      {visibleData.length >= TRAFFIC_SPARKLINE_MIN_SAMPLES ? (
        <svg
          focusable="false"
          preserveAspectRatio="none"
          viewBox={`0 0 ${TRAFFIC_SPARKLINE_WIDTH} ${TRAFFIC_SPARKLINE_HEIGHT}`}
        >
          <defs>
            <radialGradient id={fadeId} r="72%">
              <stop offset="50%" stopColor="white" />
              <stop offset="100%" stopColor="white" stopOpacity="0" />
            </radialGradient>
            <mask id={maskId}>
              <rect
                fill={`url(#${fadeId})`}
                height={TRAFFIC_SPARKLINE_HEIGHT}
                width={TRAFFIC_SPARKLINE_WIDTH}
              />
            </mask>
          </defs>
          <g mask={`url(#${maskId})`}>
            <path d={geometry.area} fill={color} fillOpacity="0.08" />
            <path
              d={geometry.line}
              fill="none"
              stroke={color}
              strokeWidth="1.35"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        </svg>
      ) : null}
    </div>
  );
}
