import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface Point {
  x: number;
  y: number;
}

interface TrafficSparklineProps {
  color: string;
  data: number[];
  id: string;
}

const height = 34;
const maxSamples = 60;
const padding = 2;
const transitionDuration = 180;
const width = 150;

export function createSparklinePoints(data: number[]): Point[] {
  const samples = data.slice(-maxSamples);
  if (samples.length === 0) return [];
  const minimum = Math.min(...samples);
  const maximum = Math.max(...samples);
  const range = Math.max(maximum - minimum, 1);
  const step = (width - padding * 2) / (maxSamples - 1);
  return samples.map((value, index) => ({
    x: padding + index * step,
    y: padding + (1 - (value - minimum) / range) * (height - padding * 2),
  }));
}

function monotoneSlopes(points: Point[]) {
  if (points.length < 2) return [];
  const deltas = points.slice(1).map((point, index) => {
    const previous = points[index];
    return (point.y - previous.y) / (point.x - previous.x);
  });
  return points.map((_, index) => {
    if (index === 0) return deltas[0];
    if (index === points.length - 1) return deltas.at(-1) ?? 0;
    const previous = deltas[index - 1];
    const next = deltas[index];
    if (previous * next <= 0) return 0;
    return (2 * previous * next) / (previous + next);
  });
}

export function createSmoothSparklineSegments(points: Point[]): string[] {
  if (points.length < 2) return [];
  const slopes = monotoneSlopes(points);
  return points.slice(1).map((point, index) => {
    const previous = points[index];
    const deltaX = point.x - previous.x;
    const previousControlX = previous.x + deltaX / 3;
    const previousControlY = previous.y + (slopes[index] * deltaX) / 3;
    const nextControlX = point.x - deltaX / 3;
    const nextControlY = point.y - (slopes[index + 1] * deltaX) / 3;
    return `M ${previous.x} ${previous.y} C ${previousControlX} ${previousControlY} ${nextControlX} ${nextControlY} ${point.x} ${point.y}`;
  });
}

export function createSmoothSparklinePath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return createSmoothSparklineSegments(points)
    .map((segment, index) => (index === 0 ? segment : segment.replace(/^M [^C]+/, "")))
    .join(" ");
}

export function createSmoothSparklinePaths(data: number[]) {
  const points = createSparklinePoints(data);
  const linePath = createSmoothSparklinePath(points);
  return {
    areaPath: linePath
      ? `${linePath} L ${points.at(-1)?.x ?? padding} ${height - padding} L ${padding} ${height - padding} Z`
      : "",
    linePath,
    points,
    segments: createSmoothSparklineSegments(points),
  };
}

function hasNewSample(previous: number[], next: number[]) {
  if (previous.length === 0 || next.length === 0 || previous.at(-1) === next.at(-1)) return false;
  if (next.length > previous.length) {
    return previous.every((value, index) => value === next[index]);
  }
  return (
    previous.length === maxSamples &&
    previous.slice(1).every((value, index) => value === next[index])
  );
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
  const samples = useMemo(() => data.slice(-maxSamples), [data]);
  const key = samples.join(",");
  const paths = useMemo(() => createSmoothSparklinePaths(samples), [key]);
  const previousSamples = useRef<number[]>([]);
  const incomingPath = useRef<SVGPathElement | null>(null);
  const animation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const previous = previousSamples.current;
    previousSamples.current = samples;
    animation.current?.cancel();
    animation.current = null;
    const path = incomingPath.current;
    if (path) {
      path.style.strokeDasharray = "";
      path.style.strokeDashoffset = "0";
    }
    if (!path || reducedMotion || !hasNewSample(previous, samples)) return;
    path.style.strokeDasharray = "1";
    path.style.strokeDashoffset = "1";
    animation.current = path.animate([{ strokeDashoffset: "1" }, { strokeDashoffset: "0" }], {
      duration: transitionDuration,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
    return () => {
      animation.current?.cancel();
      animation.current = null;
    };
  }, [key, reducedMotion]);

  if (samples.length === 0) return <div aria-hidden="true" className="traffic-sparkline" />;

  const gradientId = `${id}-area-gradient`;
  const basePoints = paths.points.slice(0, -1);
  const baseLinePath = basePoints.length > 1 ? createSmoothSparklinePath(basePoints) : "";
  const baseAreaPath = createSmoothSparklinePaths(samples.slice(0, -1)).areaPath;
  const lastSegment = paths.segments.at(-1) ?? "";
  return (
    <div aria-hidden="true" className="traffic-sparkline">
      <svg focusable="false" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.2} />
            <stop offset="100%" stopColor={color} stopOpacity={0.015} />
          </linearGradient>
        </defs>
        {baseAreaPath ? <path d={baseAreaPath} fill={`url(#${gradientId})`} /> : null}
        {baseLinePath ? (
          <path
            d={baseLinePath}
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.35"
          />
        ) : null}
        {lastSegment ? (
          <path
            d={lastSegment}
            fill="none"
            pathLength="1"
            ref={incomingPath}
            stroke={color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.35"
          />
        ) : null}
      </svg>
    </div>
  );
}
