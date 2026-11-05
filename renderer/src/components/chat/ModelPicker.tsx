import { Boxes, ChevronRight, Cpu } from 'lucide-react';
import { isBundledNativeSource } from '../../lib/inferenceUx';
import type { ProviderConfig } from '../../types';

/**
 * The compact composer entry into the central Model Library.
 *
 * Sources, prompts, runtime limits, downloads, and agent routing no longer compete for space in a
 * popup over the composer. The composer tells the truth about the one exact model this chat will
 * use; clicking it opens the full card page where those related choices have room to be legible.
 */
interface Props {
  providers: ProviderConfig[];
  providerId: string;
  modelId: string;
  disabled?: boolean;
  onOpen(): void;
}

export function ModelPicker({ providers, providerId, modelId, disabled = false, onOpen }: Props) {
  const source = providers.find((candidate) => candidate.id === providerId);
  const model = source?.models.find((candidate) => candidate.id === modelId);
  const bundledNative = source ? isBundledNativeSource(source) : false;
  const label = model?.name ?? model?.id ?? 'Choose a model';
  const title = source && model ? `${source.name} · ${model.name || model.id} · Open Model Library` : 'Open Model Library';

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onOpen}
      className="flex h-8 min-w-0 max-w-[280px] items-center gap-1.5 rounded-lg px-2.5 text-xs text-ink-2 transition hover:bg-surface-2 hover:text-ink focus:bg-surface-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      {model ? <Cpu size={14} className="shrink-0 text-ink-3" /> : <Boxes size={14} className="shrink-0 text-primary" />}
      <span className="truncate">{label}</span>
      {bundledNative && (
        <span aria-hidden="true" className="shrink-0 text-[10px] font-medium text-primary">
          native
        </span>
      )}
      <ChevronRight size={13} className="shrink-0 text-ink-3" />
    </button>
  );
}
