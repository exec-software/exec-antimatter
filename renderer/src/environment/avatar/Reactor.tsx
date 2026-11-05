import type { CoreState } from './persona';

/**
 * The core, drawn.
 *
 * A containment ring, a core, and four control rods. The rods withdraw as it works, which is the
 * one piece of reactor behaviour that reads instantly even if you know nothing about reactors:
 * pulled out means going, pushed in means stopped. Everything else is colour — the teal of a
 * reactor pool at rest, the action accent under load, red when something has tripped.
 */

interface Props {
  state: CoreState;
  size?: number;
}

const PALETTE: Record<CoreState, { core: string; ring: string; glow: string }> = {
  idle: { core: 'var(--ds-accent)', ring: 'var(--ds-border)', glow: 'rgb(var(--color-accent) / 0.45)' },
  thinking: { core: 'var(--ds-primary)', ring: 'var(--ds-primary)', glow: 'rgb(var(--color-primary) / 0.55)' },
  tool: { core: 'var(--ds-accent-hover)', ring: 'var(--ds-accent)', glow: 'rgb(var(--color-accent-strong) / 0.55)' },
  waiting: { core: 'var(--ds-warning)', ring: 'var(--ds-warning)', glow: 'rgb(var(--color-warning) / 0.5)' },
  error: { core: 'var(--ds-error)', ring: 'var(--ds-error)', glow: 'rgb(var(--color-danger) / 0.5)' },
};

export function Reactor({ state, size = 54 }: Props) {
  const hot = state === 'thinking' || state === 'tool';
  const colors = PALETTE[state];
  // Rods sit at the rim at rest and pull back toward it as power rises.
  const rodLength = hot ? 5 : 11;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 60 60"
      aria-hidden
      style={{ filter: `drop-shadow(0 0 ${hot ? 10 : 5}px ${colors.glow})` }}
    >
      <defs>
        <radialGradient id="core-fill" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={hot ? 0.95 : 0.7} />
          <stop offset="45%" stopColor={colors.core} stopOpacity="0.95" />
          <stop offset="100%" stopColor={colors.core} stopOpacity="0.15" />
        </radialGradient>
      </defs>

      {/* Vessel */}
      <circle cx="30" cy="30" r="26" fill="rgb(var(--color-surface-0))" stroke="var(--ds-border)" strokeWidth="1" />

      {/* Containment ring: dashed, and it turns while there is anything to do. */}
      <circle
        cx="30"
        cy="30"
        r="22"
        fill="none"
        stroke={colors.ring}
        strokeWidth="1.5"
        strokeDasharray="5 7"
        strokeLinecap="round"
        opacity={hot ? 0.95 : 0.5}
        className={hot ? 'core-ring-hot' : 'core-ring-idle'}
      />

      {/* Control rods, north / east / south / west. */}
      {[0, 90, 180, 270].map((angle) => (
        <line
          key={angle}
          x1="30"
          y1={30 - 25}
          x2="30"
          y2={30 - 25 + rodLength}
          stroke={colors.ring}
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity={hot ? 0.8 : 0.45}
          transform={`rotate(${angle} 30 30)`}
          style={{ transition: 'all 400ms ease' }}
        />
      ))}

      {/* The core itself. */}
      <circle
        cx="30"
        cy="30"
        r="13"
        fill="url(#core-fill)"
        className={hot ? 'core-glow-hot' : 'core-glow-idle'}
      />

      {/* Antimatter's own mark, dimly, so the thing is identifiably ours. */}
      <g stroke="#0f0f0f" strokeWidth="1.2" fill="none" opacity="0.55">
        <ellipse cx="30" cy="30" rx="9" ry="3.6" />
        <ellipse cx="30" cy="30" rx="9" ry="3.6" transform="rotate(60 30 30)" />
        <ellipse cx="30" cy="30" rx="9" ry="3.6" transform="rotate(120 30 30)" />
      </g>
    </svg>
  );
}
