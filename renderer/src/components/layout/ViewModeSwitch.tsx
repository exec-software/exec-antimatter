import { Code, MessagesSquare, Rows3, Sheet, Waypoints, type LucideIcon } from 'lucide-react';
import type { ViewMode } from '../../types';

interface Props {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}

const MODES: { id: ViewMode; label: string; title: string; icon: LucideIcon }[] = [
  { id: 'transcript', label: 'Transcript', title: 'Transcript: the conversation as chat bubbles', icon: MessagesSquare },
  { id: 'atlas', label: 'Atlas', title: 'Atlas: navigate the conversation by exchange', icon: Rows3 },
  { id: 'research', label: 'Research', title: 'Research: compare turn metrics and export your selection', icon: Sheet },
  { id: 'code', label: 'Code', title: 'Code: find and copy snippets from the conversation', icon: Code },
  { id: 'flow', label: 'Flow', title: 'Flow: follow actions, agents, and decisions behind each reply', icon: Waypoints },
];

export function ViewModeSwitch({ value, onChange }: Props) {
  return (
    <div role="radiogroup" aria-label="Chat view" className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5"
      onKeyDown={(event) => {
        const movement = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!movement && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const index = MODES.findIndex((mode) => mode.id === value);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? MODES.length - 1 : (index + movement + MODES.length) % MODES.length;
        onChange(MODES[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
      }}>
      {MODES.map(({ id, label, title, icon: Icon }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            tabIndex={active ? 0 : -1}
            title={title}
            onClick={() => onChange(id)}
            className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition ${
              active ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink'
            }`}
          >
            <Icon size={13} className={active ? 'text-primary' : undefined} />
            <span className="hidden lg:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
