import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * The two marks this panel draws.
 *
 * Utilisation is a magnitude, so a meter is one hue that simply gets longer — never a red-amber-
 * green ramp, which encodes rank in colour and forces a reader to decode a legend to learn a
 * number that is written right next to it. Colour is spent once, on the genuinely exceptional
 * state, and it never travels alone: the figure beside it always says the same thing.
 */

export type Tone = 'normal' | 'critical';

export const TONE_FILL: Record<Tone, string> = {
  normal: 'rgb(var(--color-accent))',
  critical: 'rgb(var(--color-danger))',
};

export const TONE_TEXT: Record<Tone, string> = {
  normal: 'text-ink',
  critical: 'text-danger',
};

interface MeterProps {
  /** 0..1. */
  value: number;
  tone?: Tone;
  height?: number;
  /** Drawn behind the fill, for a second quantity on the same scale (swap on a disk, say). */
  secondary?: number;
}

export function Meter({ value, tone = 'normal', height = 6, secondary }: MeterProps) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div className="relative w-full overflow-hidden rounded-full bg-surface-0" style={{ height }}>
      {secondary !== undefined && secondary > 0 && (
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-line"
          style={{ width: `${Math.max(0, Math.min(1, secondary)) * 100}%` }}
        />
      )}
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${clamped * 100}%`, background: TONE_FILL[tone] }}
      />
    </div>
  );
}

interface SparklineProps {
  /** Oldest first. Values are 0..1 unless `max` says otherwise. */
  values: number[];
  /** A second series on the same axes — never a second axis. */
  secondary?: number[];
  max?: number;
  height?: number;
  color?: string;
  secondaryColor?: string;
  /** Formats the hovered value for the readout the parent renders. */
  onHover?: (index: number | null) => void;
  label?: string;
}

/**
 * A filled line over the last minute. Two series are allowed only when they share a unit and a
 * scale — bytes in and bytes out — because a second y-axis makes any pair of lines cross
 * wherever the author chose.
 */
export function Sparkline({
  values,
  secondary,
  max,
  height = 34,
  color = 'rgb(var(--color-accent))',
  secondaryColor = 'rgb(var(--color-accent-strong))',
  onHover,
  label,
}: SparklineProps) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 100;

  const ceiling = max ?? Math.max(1, ...values, ...(secondary ?? []));
  const points = (series: number[]) =>
    series.map((value, index) => {
      const x = series.length < 2 ? 0 : (index / (series.length - 1)) * width;
      const y = height - (Math.max(0, value) / ceiling) * height;
      return `${x.toFixed(2)},${Math.max(0.5, Math.min(height - 0.5, y)).toFixed(2)}`;
    });

  const line = (series: number[]) => points(series).join(' ');
  const area = (series: number[]) => {
    const drawn = points(series);
    return drawn.length < 2 ? '' : `${drawn[0].split(',')[0]},${height} ${drawn.join(' ')} ${drawn[drawn.length - 1].split(',')[0]},${height}`;
  };

  const move = (event: ReactPointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || values.length < 2) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const index = Math.round(ratio * (values.length - 1));
    setHover(index);
    onHover?.(index);
  };

  const leave = () => {
    setHover(null);
    onHover?.(null);
  };

  return (
    <div ref={box} onPointerMove={move} onPointerLeave={leave} className="relative w-full" style={{ height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        role="img"
        aria-label={label}
      >
        {secondary && secondary.length > 1 && (
          <>
            <polygon points={area(secondary)} fill={secondaryColor} opacity={0.14} />
            <polyline points={line(secondary)} fill="none" stroke={secondaryColor} strokeWidth={2} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          </>
        )}
        {values.length > 1 && (
          <>
            <polygon points={area(values)} fill={color} opacity={0.18} />
            <polyline points={line(values)} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        )}
        {hover !== null && values.length > 1 && (
          <line
            x1={(hover / (values.length - 1)) * width}
            x2={(hover / (values.length - 1)) * width}
            y1={0}
            y2={height}
            stroke="rgb(var(--color-ink-3))"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}
