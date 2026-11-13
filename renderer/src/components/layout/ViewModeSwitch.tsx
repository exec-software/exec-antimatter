import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Code, MessagesSquare, Rows3, Sheet, Waypoints, type LucideIcon } from 'lucide-react';
import type { ViewMode } from '../../types';

interface Props {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export const CHAT_VIEW_MODES: { id: ViewMode; label: string; description: string; icon: LucideIcon }[] = [
  { id: 'transcript', label: 'Transcript', description: 'Read messages and tool calls', icon: MessagesSquare },
  { id: 'atlas', label: 'Atlas', description: 'Browse exchanges', icon: Rows3 },
  { id: 'research', label: 'Research', description: 'Compare turn metrics', icon: Sheet },
  { id: 'code', label: 'Code', description: 'Browse code snippets', icon: Code },
  { id: 'flow', label: 'Flow', description: 'Follow tools and agents', icon: Waypoints },
];

export function ViewModeSwitch({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = CHAT_VIEW_MODES.findIndex((mode) => mode.id === value);
  const active = CHAT_VIEW_MODES[Math.max(0, selected)];
  const ActiveIcon = active.icon;
  const focusAt = useRef(Math.max(0, selected));

  useEffect(() => {
    if (!open) {
      return;
    }
    menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[focusAt.current]?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return <div ref={container} className="relative ml-auto shrink-0">
    <button ref={trigger} type="button" aria-label={`Chat view: ${active.label}`} title={`Chat view: ${active.label}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => { focusAt.current = Math.max(0, selected); setOpen((current) => !current); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          focusAt.current = event.key === 'ArrowUp' ? CHAT_VIEW_MODES.length - 1 : Math.max(0, selected);
          setOpen(true);
        }
      }}
      className={`flex h-7 items-center gap-0.5 rounded-md px-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${open ? 'bg-surface-3 text-primary' : 'text-ink-3 hover:bg-surface-3 hover:text-ink'}`}>
      <ActiveIcon size={16} /><ChevronDown size={11} />
    </button>
    {open && <div ref={menu} id={menuId} role="menu" aria-label="Chat view" className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border border-line bg-surface-2 p-1 shadow-xl"
      onKeyDown={(event) => {
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const move = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
        if (move || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + move + items.length) % items.length;
          items[next]?.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === 'Tab') {
          event.preventDefault();
          const items = [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
            .filter((item) => item.tabIndex >= 0 && !item.matches(':disabled') && item.getClientRects().length > 0 && !menu.current?.contains(item));
          const index = items.indexOf(trigger.current!);
          setOpen(false);
          items[index + (event.shiftKey ? -1 : 1)]?.focus();
        } else if (event.key.length === 1 && /[a-z]/i.test(event.key)) {
          const next = CHAT_VIEW_MODES.findIndex((mode) => mode.label.toLowerCase().startsWith(event.key.toLowerCase()));
          if (next >= 0) {
            event.preventDefault();
            items[next]?.focus();
          }
        }
      }}>
      {CHAT_VIEW_MODES.map(({ id, label, description, icon: Icon }) => <button key={id} type="button" role="menuitemradio"
        aria-checked={id === value} aria-label={label} tabIndex={-1}
        onClick={() => { onChange(id); close(); }}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-3 focus:bg-surface-3 focus:outline-none ${id === value ? 'text-primary' : 'text-ink-2'}`}>
        <Icon size={16} className="shrink-0" />
        <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{label}</span><span className="block text-[10px] text-ink-3">{description}</span></span>
        {id === value && <Check size={13} />}
      </button>)}
    </div>}
  </div>;
}
