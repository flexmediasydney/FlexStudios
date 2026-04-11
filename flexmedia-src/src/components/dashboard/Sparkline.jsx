import { useMemo } from "react";

export default function Sparkline({ data = [], width = 80, height = 24, color = "currentColor", className = "", label = "Trend" }) {
  const path = useMemo(() => {
    if (data.length < 2) return "";
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const points = data.map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return points.join(' ');
  }, [data, width, height]);

  if (data.length < 2) {
    return (
      <span className={`inline-block text-xs text-muted-foreground ${className}`} style={{ width, height, lineHeight: `${height}px` }} title="Not enough data">
        --
      </span>
    );
  }

  const latest = data[data.length - 1];
  const first = data[0];
  const trend = latest >= first ? "up" : "down";

  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}: ${data.length} points, trending ${trend}`}
    >
      <title>{`${label}: ${latest} (${trend} from ${first})`}</title>
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={parseFloat(path.split(',').pop())} r="2" fill={color} />
    </svg>
  );
}
