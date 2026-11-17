import { LayoutGrid, Mail, MessagesSquare, Presentation } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppPage } from '../../types';

/**
 * Desk: a launcher for the tools that are not the work.
 *
 * Comms and Email sat in the main navigation beside Code, Agents and Cluster, which put them in
 * the same list as the things a conversation is actually made of. They are not peers of those —
 * they are separate applications that happen to live in the same window, and a flat list cannot
 * say so.
 *
 * A grid by Settings can. It is the arrangement people already read as "other apps" from every
 * other suite they use, so nothing has to be learned, and it leaves the navigation above about
 * one subject: the work in front of them.
 *
 * Built now, while there are two things in it, because the alternative is to build the suite
 * first and reorganise afterwards — and by then every tool has a nav row somebody is used to.
 * The order here is the order they appear; adding one is a line.
 */

interface DeskApp {
  page: AppPage;
  label: string;
  description: string;
  icon: typeof Mail;
  /** Whether this app is switched on at all; a hidden one leaves no gap in the grid. */
  enabled: boolean;
}

interface Props {
  page: AppPage;
  /**
   * Which apps exist. `whiteboard` is the experiment's flag rather than a sidebar preference, so
   * it is off unless explicitly on — the others are on unless explicitly off.
   */
  visibility: { comms?: boolean; email?: boolean; whiteboard?: boolean };
  onChangePage: (page: AppPage) => void;
  /** Shared with the Settings and Developer rows so the footer reads as one group. */
  rowClass: string;
  active: boolean;
}

export function deskApps(visibility: Props['visibility']): DeskApp[] {
  const apps: DeskApp[] = [
    {
      page: 'comms',
      label: 'Comms',
      description: 'Channels and direct messages',
      icon: MessagesSquare,
      enabled: visibility.comms !== false,
    },
    {
      page: 'email',
      label: 'Email',
      description: 'Mail for this account',
      icon: Mail,
      enabled: visibility.email !== false,
    },
    {
      // Here rather than beside the chat, which is where it first went. A board is per
      // conversation, so the Desk entry opens the current one's — but it is a surface you go to
      // in order to plan, not a part of the conversation you are reading, and the navigation
      // above is for the latter. Listing it in both places would be the duplication this
      // launcher exists to remove.
      page: 'whiteboard',
      label: 'Whiteboard',
      description: "Plan on one surface with the model — this conversation's board",
      icon: Presentation,
      // Experimental, so absent unless switched on.
      enabled: visibility.whiteboard === true,
    },
  ];
  return apps.filter((app) => app.enabled);
}

export function DeskMenu({ page, visibility, onChangePage, rowClass, active }: Props) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const apps = deskApps(visibility);

  // Nothing switched on means no launcher. An empty grid is worse than an absent one: it reads
  // as a feature that is broken rather than one that is off.
  useEffect(() => {
    if (!apps.length) setOpen(false);
  }, [apps.length]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Capture, so a click that lands on something which stops propagation still closes this.
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  if (!apps.length) return null;

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Desk"
        title="Desk — Comms, Email, Whiteboard and other tools"
        className={`${rowClass} w-full text-xs ${active ? 'bg-primary/10 text-primary' : 'text-ink-2 hover:bg-surface-3/60'}`}
      >
        <LayoutGrid size={14} className={active ? 'text-primary' : 'text-ink-3'} />
        Desk
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Desk"
          className="absolute bottom-full left-0 z-20 mb-1 w-64 rounded-lg border border-line bg-surface-2 p-1.5 shadow-lg"
        >
          <div className="grid grid-cols-3 gap-1.5">
            {apps.map(({ page: target, label, description, icon: Icon }) => (
              <button
                key={target}
                type="button"
                role="menuitem"
                title={description}
                onClick={() => {
                  setOpen(false);
                  onChangePage(target);
                }}
                className={`flex flex-col items-center gap-1.5 rounded-md px-2 py-3 text-[11px] transition ${
                  page === target ? 'bg-primary/10 text-primary' : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink'
                }`}
              >
                <Icon size={18} className={page === target ? 'text-primary' : 'text-ink-3'} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
