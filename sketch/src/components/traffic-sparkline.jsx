import { Area, AreaChart, ResponsiveContainer } from "recharts";

export function TrafficSparkline({ color, data, id }) {
  const points = data.map((value, index) => ({ index, value }));
  const gradientId = `${id}-area-gradient`;

  return (
    <div className="traffic-sparkline" aria-hidden="true">
      <ResponsiveContainer height="100%" width="100%">
        <AreaChart accessibilityLayer={false} data={points} margin={{ bottom: 1, left: 0, right: 0, top: 2 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.2} />
              <stop offset="100%" stopColor={color} stopOpacity={0.015} />
            </linearGradient>
          </defs>
          <Area
            dataKey="value"
            dot={false}
            fill={`url(#${gradientId})`}
            fillOpacity={1}
            isAnimationActive={false}
            stroke={color}
            strokeWidth={1.35}
            type="monotone"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
