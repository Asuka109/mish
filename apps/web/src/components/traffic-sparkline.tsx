import { useEffect, useMemo, useRef, useState } from "react";

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
const padding = 2;
const width = 150;
const transitionDuration = 180;

export function createSparklinePoints(data: number[]): Point[] {
  if (data.length === 0) return [];
  const minimum = Math.min(...data);
  const maximum = Math.max(...data);
  const range = Math.max(maximum - minimum, 1);
  return data.map((value, index) => ({
    x: padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2),
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

export function createSmoothSparklinePath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const slopes = monotoneSlopes(points);
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const deltaX = point.x - previous.x;
    const previousControlX = previous.x + deltaX / 3;
    const previousControlY = previous.y + (slopes[index] * deltaX) / 3;
    const nextControlX = point.x - deltaX / 3;
    const nextControlY = point.y - (slopes[index + 1] * deltaX) / 3;
    return `${path} C ${previousControlX} ${previousControlY} ${nextControlX} ${nextControlY} ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}

export function createSmoothSparklinePaths(data: number[]) {
  const points = createSparklinePoints(data);
  const linePath = createSmoothSparklinePath(points);
  return {
    areaPath: linePath
      ? `${linePath} L ${width - padding} ${height - padding} L ${padding} ${height - padding} Z`
      : "",
    linePath,
    points,
  };
}

function sampleY(points: Point[], progress: number) {
  if (points.length === 1) return points[0].y;
  const position = progress * (points.length - 1);
  const index = Math.min(Math.floor(position), points.length - 2);
  const remainder = position - index;
  return points[index].y + (points[index + 1].y - points[index].y) * remainder;
}

function interpolatePoints(previous: Point[], next: Point[], progress: number): Point[] {
  return next.map((point, index) => {
    const previousY = sampleY(previous, index / Math.max(next.length - 1, 1));
    return { x: point.x, y: previousY + (point.y - previousY) * progress };
  });
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
  const target = useMemo(() => createSmoothSparklinePaths(data), [data]);
  const [renderedPoints, setRenderedPoints] = useState(target.points);
  const renderedRef = useRef(target.points);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (target.points.length === 0) {
      renderedRef.current = [];
      setRenderedPoints([]);
      return;
    }
    if (reducedMotion || renderedRef.current.length === 0) {
      renderedRef.current = target.points;
      setRenderedPoints(target.points);
      return;
    }
    const start = performance.now();
    const initial = renderedRef.current;
    const tick = (now: number) => {
      const progress = Math.min((now - start) / transitionDuration, 1);
      const points = interpolatePoints(initial, target.points, progress);
      renderedRef.current = points;
      setRenderedPoints(points);
      if (progress < 1) frameRef.current = requestAnimationFrame(tick);
      else frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [reducedMotion, target.points]);

  if (data.length === 0) return <div aria-hidden="true" className="traffic-sparkline" />;

  const gradientId = `${id}-area-gradient`;
  const linePath = createSmoothSparklinePath(renderedPoints);
  const areaPath = `${linePath} L ${width - padding} ${height - padding} L ${padding} ${height - padding} Z`;
  return (
    <div aria-hidden="true" className="traffic-sparkline">
      <svg focusable="false" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.2} />
            <stop offset="100%" stopColor={color} stopOpacity={0.015} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.35"
        />
      </svg>
    </div>
  );
}
