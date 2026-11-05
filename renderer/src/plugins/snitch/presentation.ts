import type { ItemStatus, ItemValue, PipelineStage } from '../../types';

/** Labels and colours shared by the Snitch panels, so a stage looks the same wherever it shows. */

export const STATUS_LABELS: Record<ItemStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const VALUE_LABELS: Record<ItemValue, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const VALUE_COLORS: Record<ItemValue, string> = {
  critical: 'text-danger',
  high: 'text-primary',
  medium: 'text-ink-2',
  low: 'text-ink-3',
};

export const VALUE_DOTS: Record<ItemValue, string> = {
  critical: 'bg-danger',
  high: 'bg-primary',
  medium: 'bg-ink-3',
  low: 'bg-line',
};

export interface StageLook {
  label: string;
  /** What the stage means, in the words someone reading the panel would use. */
  hint: string;
  chip: string;
}

export const STAGES: Record<PipelineStage, StageLook> = {
  idle: { label: 'Not dispatched', hint: 'Nothing is working on this.', chip: 'text-ink-3 border-line' },
  queued: { label: 'Queued', hint: 'Waiting for a free agent slot.', chip: 'text-ink-2 border-line' },
  fixing: { label: 'Fixing', hint: 'An agent is changing the code.', chip: 'text-primary border-primary/50 bg-primary/10' },
  qa: { label: 'QA', hint: 'A second pass is checking the fix.', chip: 'text-accent border-accent/50 bg-accent/10' },
  verified: { label: 'Verified', hint: 'QA passed. Review the change and close it.', chip: 'text-accent-strong border-accent/60 bg-accent/10' },
  failed: { label: 'Needs a human', hint: 'The loop gave up; read the note.', chip: 'text-danger border-danger/50 bg-danger/10' },
};

export const relativeTime = (iso: string | null): string => {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';

  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
};
