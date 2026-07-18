interface TrafficSparklineProps {
  color: string;
  data: number[];
  id: string;
}

export function TrafficSparkline({ color, data, id }: TrafficSparklineProps) {
  const gradientId = `${id}-area-gradient`;
  const width = 150;
  const height = 34;
  const padding = 2;
  const minimum = Math.min(...data);
  const maximum = Math.max(...data);
  const range = Math.max(maximum - minimum, 1);
  const points = data.map((value, index) => {
    const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2);
    const y = padding + (1 - (value - minimum) / range) * (height - padding * 2);
    return [x, y] as const;
  });
  const linePath = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
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
