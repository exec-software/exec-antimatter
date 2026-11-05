import { useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { PanelRight, PictureInPicture2, ExternalLink, X } from 'lucide-react';
import type { ToolWindowAnchor, ToolWindowDef } from './types';

/**
 * The chrome around a tool window: a title bar with the actions that move it between docked and
 * floating, and nothing else. The panel inside is identical in both modes, which is the point —
 * a plugin writes one component and the shell decides where it lives.
 */

interface Props {
  definition: ToolWindowDef;
  floating: boolean;
  onFloat(): void;
  onDock(): void;
  onClose(): void;
  onDetach?(): Promise<void>;
  /** Set on a floating window so its title bar moves it. */
  onDragStart?(event: ReactPointerEvent): void;
  /** Where this window is now, and where it can be sent. Omitted leaves the picker out. */
  placement?: ToolWindowAnchor;
  onPlace?(anchor: ToolWindowAnchor): void;
  children: ReactNode;
}

const action = 'rounded p-1 text-ink-3 transition hover:bg-surface-3 hover:text-ink';

/** Every place a window can be sent, in the order they appear around the shell. */
const PLACEMENTS: { anchor: ToolWindowAnchor; label: string }[] = [
  { anchor: 'left', label: 'Left side' },
  { anchor: 'right', label: 'Right side' },
  { anchor: 'top', label: 'Drop console' },
  { anchor: 'bottom', label: 'Bottom' },
  { anchor: 'band-left', label: 'Band, left of prompt' },
  { anchor: 'band-right', label: 'Band, right of prompt' },
];

export function ToolWindowFrame({
  definition, floating, onFloat, onDock, onClose, onDragStart, placement, onPlace, onDetach, children,
}: Props) {
  const Icon = definition.icon;
  const [detaching, setDetaching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-2">
      <header
        onPointerDown={onDragStart}
        className={`flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-1.5 ${
          floating ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
      >
        <Icon size={13} className="shrink-0 text-primary" />
        <h2 className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          {definition.title}
        </h2>
        {placement && onPlace && (
          // A native select rather than a bespoke menu: it is one control, it is reachable by
          // keyboard for free, and a title bar is not the place to reinvent a popup.
          <select
            aria-label={`Move ${definition.title}`}
            title="Move this panel"
            value={placement}
            // The title bar drags a floating window, so the pointer must not reach it from here.
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onPlace(event.target.value as ToolWindowAnchor)}
            className="max-w-[7.5rem] rounded border border-line bg-surface-3 px-1 py-0.5 text-[10px] text-ink-2 focus:border-primary focus:outline-none"
          >
            {PLACEMENTS.map((option) => (
              <option key={option.anchor} value={option.anchor}>{option.label}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={floating ? onDock : onFloat}
          title={floating ? 'Dock to the side' : 'Float this window'}
          className={action}
        >
          {floating ? <PanelRight size={12} /> : <PictureInPicture2 size={12} />}
        </button>
        {onDetach && <button type="button" title="Detach into a separate window" className={action} disabled={detaching}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => { setDetaching(true); setError(null); void onDetach().catch((reason: unknown) => setError(String(reason))).finally(() => setDetaching(false)); }}>
          <ExternalLink size={12} />
        </button>}
        <button type="button" onClick={onClose} title="Hide" className={action}>
          <X size={12} />
        </button>
      </header>

      {error && <div role="alert" className="px-2 py-1 text-xs text-danger">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}
