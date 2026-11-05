import { ListFilter, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeMenu } from '../../lib/menu';
import { SIDEBAR_SECTION_GROUPS, type SidebarSectionId, type SidebarVisibility } from '../../lib/sidebarVisibility';

interface Props {
  visibility: SidebarVisibility;
  botChatEnabled: boolean;
  onChange: (id: SidebarSectionId, visible: boolean) => void;
  onShowAll: () => void;
}

/** A non-modal popover: native checkboxes support Tab/Space, and Escape returns to its opener. */
export function SidebarCustomization({ visibility, botChatEnabled, onChange, onShowAll }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const hidden = SIDEBAR_SECTION_GROUPS.reduce((count, group) => count + group.sections
    .filter((section) => (section.id !== 'bot-chat' || botChatEnabled) && !visibility[section.id]).length, 0);

  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = panel.current.getBoundingClientRect();
    setPosition(placeMenu({ x: anchor.right + 8, y: anchor.bottom }, bounds, { width: window.innerWidth, height: window.innerHeight }));
  }, [open]);

  useLayoutEffect(() => {
    if (open && position) panel.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const closeAndFocus = () => { setOpen(false); trigger.current?.focus(); };

  return <>
    <button ref={trigger} type="button" aria-label="Customize sidebar" aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setPosition(null); setOpen((value) => !value); }}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ink-2 transition hover:bg-surface-3/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      <ListFilter size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
      <span className="min-w-0 flex-1">Customize sidebar</span>
      {hidden > 0 && <span className="shrink-0 text-[10px] text-ink-3" title={`${hidden} sections hidden`}>{hidden}</span>}
    </button>
    {open && createPortal(
      <div ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
        className="fixed z-[1000] flex w-80 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-line bg-surface-2 text-ink shadow-2xl"
        style={{ left: position?.left ?? 0, top: position?.top ?? 0, maxHeight: 'min(680px, calc(100vh - 16px))', visibility: position ? 'visible' : 'hidden' }}>
        <div className="shrink-0 border-b border-line p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id={`${id}-title`} className="text-sm font-semibold">Customize sidebar</h2>
            <button type="button" onClick={closeAndFocus} aria-label="Close sidebar customization"
              className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><X size={16} /></button>
          </div>
          <p id={`${id}-description`} className="mt-2 text-xs leading-relaxed text-ink-3">Choose what appears on this computer. Hidden chats still appear in search. Nothing is deleted or disabled.</p>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          {SIDEBAR_SECTION_GROUPS.map((group) => <fieldset key={group.label} className="mb-4 last:mb-0">
            <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">{group.label}</legend>
            {group.sections.filter((section) => section.id !== 'bot-chat' || botChatEnabled).map((section) => <label key={section.id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-xs text-ink-2 hover:bg-surface-3/60">
              <input type="checkbox" checked={visibility[section.id]} onChange={(event) => onChange(section.id, event.target.checked)}
                className="h-3.5 w-3.5 shrink-0 accent-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
              {section.label}
            </label>)}
          </fieldset>)}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line p-3">
          <button type="button" onClick={onShowAll} disabled={Object.values(visibility).every(Boolean)}
            className="rounded-md px-3 py-1.5 text-xs text-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40">Show all</button>
          <button type="button" onClick={closeAndFocus}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Done</button>
        </div>
      </div>, document.body
    )}
  </>;
}
