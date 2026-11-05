import { thinkingSupport } from '../../../../src/api/thinking';
import type { ThinkingLevel } from '../../../../src/api/types';
import type { ProviderConfig } from '../../types';

const LABELS: Record<ThinkingLevel, string> = { default: 'Model default', off: 'Off', low: 'Low', medium: 'Medium', high: 'High' };

export function ThinkingLevelField({ source, modelId, value, onChange }: {
  source: Pick<ProviderConfig, 'kind' | 'protocol'>;
  modelId: string;
  value: ThinkingLevel;
  onChange(value: ThinkingLevel): void;
}) {
  const support = thinkingSupport(source, modelId);
  return <label className="block text-[11px] text-ink-3">
    <span className="mb-1 block">Thinking level</span>
    <select aria-label="Thinking level" value={support.levels.includes(value) ? value : 'default'}
      disabled={support.levels.length === 1} onChange={(event) => onChange(event.target.value as ThinkingLevel)}
      className="w-full rounded border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink disabled:opacity-50">
      {support.levels.map((level) => <option key={level} value={level}>{LABELS[level]}</option>)}
    </select>
    <span className="mt-1 block text-[10px] leading-relaxed">{support.description}</span>
  </label>;
}
