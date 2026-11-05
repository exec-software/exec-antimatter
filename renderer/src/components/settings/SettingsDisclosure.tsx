import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** Lazy once, then hidden: collapsing a section must not throw away its unsaved form. */
export function SettingsDisclosure({ id, title, description, open, onToggle, children }: {
  id: string; title: string; description: string; open: boolean; onToggle(): void; children: ReactNode;
}) {
  const [visited, setVisited] = useState(open);
  useEffect(() => { if (open) setVisited(true); }, [open]);
  return <section id={`settings-detail-${id}`} className="border-t border-line py-1">
    <button type="button" aria-expanded={open} aria-controls={`settings-content-${id}`} onClick={onToggle}
      className="flex w-full items-center gap-3 rounded-md py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-ink-3">{description}</span></span>
      <ChevronDown size={15} className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    <div id={`settings-content-${id}`} hidden={!open}>{(open || visited) && <div className="pb-5">{children}</div>}</div>
  </section>;
}
