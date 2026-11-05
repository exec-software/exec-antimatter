import { useEffect, useRef, useState } from 'react';
import { Check, Eye, FolderLock, FolderOpen, Hand, ShieldAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { AccessMode, AccessSettings } from '../../types';

interface Props {
  settings: AccessSettings;
  onChange: (settings: AccessSettings) => void;
  /**
   * Where the tool servers are actually pointed. Not the same as `settings.directory`: that is
   * only set once someone picks a folder, while the tools always have *some* working directory.
   * Showing the chosen one and hiding the effective one is how a turn came to rewrite a
   * repository nobody had nominated.
   */
  workspace: string | null;
  /** False when the directory was inherited rather than chosen; writes are refused until it is. */
  confirmed: boolean;
  onConfirm: () => void;
  onChooseDirectory?: () => Promise<string | null>;
}

const MODES: { id: AccessMode; label: string; description: string; icon: LucideIcon }[] = [
  { id: 'read', label: 'Read only', description: 'Browse files; no edits or commands', icon: Eye },
  { id: 'ask', label: 'Ask first', description: 'Confirm each edit and command', icon: Hand },
  {
    id: 'full',
    label: 'Full access',
    description: 'Edit files and run commands without asking, except commands that change the machine',
    icon: ShieldAlert,
  },
];

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function AccessMenu({ settings, onChange, workspace, confirmed, onConfirm, onChooseDirectory }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = MODES.find((candidate) => candidate.id === settings.mode) ?? MODES[1];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const chooseDirectory = async () => {
    const directory = await (onChooseDirectory ? onChooseDirectory() : window.electronAPI.workspace.chooseDirectory());
    if (directory) onChange({ ...settings, directory });
  };

  // Always name the directory, chosen or inherited — silence here reads as "nowhere".
  const effective = settings.directory ?? workspace;
  const label = effective ? `${mode.label} · ${folderName(effective)}` : mode.label;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          `Permissions: ${mode.label}\n` +
          (effective
            ? `Tools work inside: ${effective}\n${
                confirmed ? 'Confirmed as the working directory.' : 'Inherited, not chosen — writes are refused until you confirm it.'
              }`
            : 'No working directory set.')
        }
        className={`flex h-8 min-w-0 max-w-[220px] items-center gap-1.5 rounded-lg px-2 text-xs transition hover:bg-surface-2 hover:text-ink ${
          open ? 'bg-surface-2 text-ink' : 'text-ink-2'
        }`}
      >
        {effective && !confirmed ? (
          <TriangleAlert size={15} className="shrink-0 text-primary" />
        ) : (
          <FolderLock size={15} className={`shrink-0 ${settings.mode === 'full' ? 'text-danger' : 'text-ink-3'}`} />
        )}
        <span className="truncate">{label}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Permissions and working directory"
          className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-xl border border-line bg-surface-2 p-3 shadow-xl shadow-black/40"
        >
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">Working directory</p>
          <button
            type="button"
            onClick={chooseDirectory}
            className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-3 px-2.5 py-2 text-left text-xs text-ink transition hover:border-primary/60"
          >
            <FolderOpen size={14} className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">{effective ?? 'Choose a folder…'}</span>
            {effective && <span className="shrink-0 text-[11px] text-ink-3">Change</span>}
          </button>

          {effective && !confirmed && (
            // Inherited from somewhere else — a previous session, or an orchestrator run. Reading
            // it is harmless; writing to a directory nobody nominated is how a README got lost.
            <div className="mt-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-2">
                <TriangleAlert size={12} className="mt-0.5 shrink-0 text-primary" />
                <span>
                  Antimatter did not choose this directory — it was inherited. Reading works; anything that
                  <strong className="font-medium text-ink"> changes files is refused</strong> until you say this is the
                  right place.
                </span>
              </p>
              <button
                type="button"
                onClick={onConfirm}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2 py-1.5 text-[11px] font-medium text-on-primary transition hover:bg-primary-strong"
              >
                <Check size={12} />
                Work here
              </button>
            </div>
          )}

          <p className="mb-1.5 mt-3 text-[11px] font-medium uppercase tracking-wide text-ink-3">Permissions</p>
          <div role="radiogroup" aria-label="Permissions" className="grid grid-cols-1 gap-0.5">
            {MODES.map(({ id, label: modeLabel, description, icon: Icon }) => {
              const selected = id === settings.mode;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange({ ...settings, mode: id })}
                  className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                    selected ? 'bg-primary/10' : 'hover:bg-surface-3'
                  }`}
                >
                  <Icon size={14} className={`mt-0.5 shrink-0 ${selected ? 'text-primary' : 'text-ink-3'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-xs font-medium ${selected ? 'text-ink' : 'text-ink-2'}`}>{modeLabel}</span>
                    <span className="block text-[11px] text-ink-3">{description}</span>
                  </span>
                  {selected && <Check size={14} className="mt-0.5 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-ink-3">Permission changes apply to pending and future tool calls in this conversation. They do not undo tools already running.</p>
        </div>
      )}
    </div>
  );
}
