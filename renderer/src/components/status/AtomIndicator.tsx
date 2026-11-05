import { useEffect, useState } from 'react';
import type { ActivityPhase } from '../../types';

interface Props {
  phase: ActivityPhase;
  size?: number;
}

// One elliptical orbit (rx 10, ry 3.6) around the centre of the 24×24 viewBox, as two arcs.
const ORBIT_PATH = 'M 2 12 A 10 3.6 0 1 1 22 12 A 10 3.6 0 1 1 2 12';
const ORBIT_ANGLES = [0, 60, 120];
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION).matches);
  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION);
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * Antimatter's atom mark, doubling as the activity indicator. Idle it is a still icon;
 * while the model thinks, bright electrons orbit and the nucleus pulses; once tokens
 * stream, the electrons turn teal and orbit faster. Animation styles live in index.css.
 */
export function AtomIndicator({ phase, size = 22 }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const active = phase === 'thinking' || phase === 'streaming';
  const orbitSeconds = phase === 'streaming' ? 0.9 : 1.8;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`atom-${phase} shrink-0 ${phase === 'error' ? 'text-danger' : 'text-primary'}`}
    >
      <g className="atom-orbits">
        {ORBIT_ANGLES.map((angle, index) => (
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <ellipse
              cx="12"
              cy="12"
              rx="10"
              ry="3.6"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity={active ? 0.5 : 0.9}
            />
            {active && !reducedMotion && (
              <circle r="1.9" className={phase === 'streaming' ? 'fill-accent' : 'fill-ink'}>
                <animateMotion
                  path={ORBIT_PATH}
                  dur={`${orbitSeconds}s`}
                  begin={`-${((orbitSeconds / ORBIT_ANGLES.length) * index).toFixed(2)}s`}
                  repeatCount="indefinite"
                />
              </circle>
            )}
          </g>
        ))}
      </g>
      <circle className="atom-nucleus" cx="12" cy="12" r="2.1" fill="currentColor" />
    </svg>
  );
}
