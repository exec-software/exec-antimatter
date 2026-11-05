import { useMemo, useSyncExternalStore } from 'react';
import { getAppearance, subscribeAppearance } from '../../appearance';
import { paletteFor } from '../../theme';
import {
  AudioLines,
  BookOpen,
  Bot,
  CodeXml,
  Compass,
  FileText,
  FlaskConical,
  Image,
  ScanSearch,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';

/**
 * A subagent's mark: a colour and a symbol, the same everywhere it appears.
 *
 * With several agents at work, the card beside the transcript is read at a glance, and a glance
 * reads colour and shape before it reads a name. Both are derived from the agent itself, so the
 * explorer is the same mark in every conversation, on every launch.
 */

/**
 * Distinct identity hues on the dark surfaces, avoiding semantic error red:
 * a red mark beside a working agent reads as something gone wrong.
 */
const PALETTE = ['#5aa7f2', '#3fbfa9', '#a58af5', '#ec7cb8', '#f0c24b', '#9ccc65', '#f5a97f', '#7fd0e6'];

/** First match wins, so the more specific words come first. */
const SYMBOLS: [RegExp, LucideIcon][] = [
  [/secur/, ShieldCheck],
  [/review/, ScanSearch],
  [/test/, FlaskConical],
  [/doc|writ/, FileText],
  [/explor|orient/, Compass],
  [/research|read-only/, BookOpen],
  [/shell|build|run/, SquareTerminal],
  [/audio|speech|voice/, AudioLines],
  [/image|media/, Image],
  [/code/, CodeXml],
];

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) >>> 0;
  return value;
}

export function agentColor(agentId: string): string {
  return PALETTE[hash(agentId) % PALETTE.length];
}

export function agentSymbol(agentId: string, tags: readonly string[] = []): LucideIcon {
  const words = `${agentId} ${tags.join(' ')}`.toLowerCase();
  return SYMBOLS.find(([pattern]) => pattern.test(words))?.[1] ?? Bot;
}

interface Props {
  agentId: string;
  tags?: readonly string[];
  size?: number;
  /** A running agent's mark breathes, so the card shows who is busy without reading anything. */
  active?: boolean;
  className?: string;
}

export function AgentGlyph({ agentId, tags, size = 20, active = false, className = '' }: Props) {
  const { theme } = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  // Preserve each agent's identity hue, with a darker tone on the light surfaces.
  const color = useMemo(() => theme === 'dark' ? agentColor(agentId)
    : paletteFor({ theme, secondaryAccent: agentColor(agentId) }).accent, [agentId, theme]);
  const Symbol = agentSymbol(agentId, tags);
  return (
    <span
      aria-hidden="true"
      className={`relative flex shrink-0 items-center justify-center rounded-md ${active ? 'agent-glyph-active' : ''} ${className}`}
      style={{ width: size, height: size, color, backgroundColor: `${color}26`, boxShadow: `inset 0 0 0 1px ${color}40` }}
    >
      <Symbol size={Math.round(size * 0.6)} strokeWidth={2.2} />
    </span>
  );
}
