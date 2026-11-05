import { isDetachableToolWindow } from '../../../src/api/detachedWindows';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { toolWindows } from './registry';
import { beginDrag } from './drag';
import { ToolWindowFrame } from './chrome';
import { DOCK_LIMITS, MIN_PANE_PX, type ToolWindowLayout } from './layout';
import type { BandSide, ToolWindowAnchor, ToolWindowDef } from './types';

/**
 * The shell side of the tool window system: the stripe that launches them, the docks they slide
 * into, and the layer they float in.
 */

interface StripeButtonProps {
  definition: ToolWindowDef;
  active: boolean;
  onClick(): void;
}

/** Its own component so a tool window's badge hook has a stable place to live. */
function StripeButton({ definition, active, onClick }: StripeButtonProps) {
  const Icon = definition.icon;
  const badge = definition.useBadge?.() ?? null;

  return (
    <button
      type="button"
      onClick={onClick}
      title={definition.description ?? definition.title}
      className={`relative flex w-full flex-col items-center gap-1.5 py-2.5 text-[10px] transition ${
        active ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:bg-surface-3/60 hover:text-ink-2'
      }`}
    >
      <span className={`absolute left-0 top-0 h-full w-0.5 ${active ? 'bg-primary' : 'bg-transparent'}`} />
      <Icon size={15} className={active ? 'text-primary' : ''} />
      <span className="[writing-mode:vertical-rl] tracking-wide">{definition.title}</span>
      {badge !== null && badge > 0 && (
        <span className="absolute right-1 top-1 min-w-[14px] rounded-full bg-primary px-1 text-[9px] font-semibold leading-[14px] text-on-primary">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

/**
 * One stripe on the right edge carrying every tool window. Where a window docks is its own
 * business; the stripe is only how you get to it, which keeps the launcher in one place instead
 * of splitting it across three edges of a 1200px window.
 */
export function ToolStripe({ layout }: { layout: ToolWindowLayout }) {
  const all = toolWindows();
  if (!all.length) return null;

  const sides = all.filter((window) => layout.homeOf(window.id) !== 'bottom');
  const bottom = all.filter((window) => layout.homeOf(window.id) === 'bottom');
  sides.sort((a, b) => Number(layout.homeOf(b.id) === 'top') - Number(layout.homeOf(a.id) === 'top'));

  return (
    <nav className="flex w-9 shrink-0 flex-col border-l border-line bg-surface-2">
      <div className="flex flex-col">
        {sides.map((definition) => (
          <StripeButton
            key={definition.id}
            definition={definition}
            active={layout.isOpen(definition.id)}
            onClick={() => layout.toggle(definition.id)}
          />
        ))}
      </div>
      {bottom.length > 0 && (
        <div className="mt-auto flex flex-col border-t border-line">
          {bottom.map((definition) => (
            <StripeButton
              key={definition.id}
              definition={definition}
              active={layout.isOpen(definition.id)}
              onClick={() => layout.toggle(definition.id)}
            />
          ))}
        </div>
      )}
    </nav>
  );
}

interface DockProps {
  /**
   * `top` is not a dock — it drops over the content instead; see DropConsole. The band sides are
   * not docks either: they divide one row around the composer, which WidgetBand lays out.
   */
  anchor: Exclude<ToolWindowAnchor, 'top' | BandSide>;
  layout: ToolWindowLayout;
}

/**
 * The docked windows for one anchor, sharing its extent.
 *
 * More than one open at a time is the ordinary case, not a special mode: watching a queue is
 * useless if it costs you sight of the thing being queued. Panes stack along the anchor and
 * divide it by weight, with a divider between each pair that trades space between neighbours
 * rather than reflowing the lot.
 */
export function Dock({ anchor, layout }: DockProps) {
  const startSize = useRef(0);
  const startWeights = useRef<number[]>([]);
  const paneBox = useRef<number>(0);

  const windows = layout.dockedAt(anchor);
  if (!windows.length) return null;

  const size = layout.layout.size[anchor];
  const vertical = anchor !== 'bottom';
  const weights = layout.sharesAt(anchor);
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;

  // The dock's own edge, against the main area.
  const resizeDock = (event: ReactPointerEvent) => {
    startSize.current = size;
    beginDrag(event, ({ dx, dy }) => {
      const delta = anchor === 'left' ? dx : anchor === 'right' ? -dx : -dy;
      layout.setDockSize(anchor, startSize.current + delta);
    });
  };

  /** The divider between two panes: what one gains the other gives up. */
  const resizePane = (index: number) => (event: ReactPointerEvent) => {
    startWeights.current = [...weights];
    // Panes stack across the dock's extent, so that is what a weight is a share of.
    paneBox.current = size;
    beginDrag(event, ({ dx, dy }) => {
      const moved = vertical ? dy : dx;
      const span = Math.max(1, paneBox.current);
      const before = startWeights.current[index];
      const after = startWeights.current[index + 1];
      const pair = before + after;
      // Convert the pixels dragged into a share of the pair, and refuse to crush either.
      const shift = (moved / span) * total;
      const floor = (MIN_PANE_PX / span) * total;
      const nextBefore = Math.min(Math.max(before + shift, floor), pair - floor);
      const next = [...startWeights.current];
      next[index] = nextBefore;
      next[index + 1] = pair - nextBefore;
      layout.setSplit(anchor, index, next);
    });
  };

  const dockHandle = vertical
    ? `absolute inset-y-0 ${anchor === 'right' ? 'left-0' : 'right-0'} w-1 cursor-col-resize`
    : 'absolute inset-x-0 top-0 h-1 cursor-row-resize';

  return (
    <div
      className={`relative flex shrink-0 flex-col ${
        anchor === 'right' ? 'border-l' : anchor === 'left' ? 'border-r' : 'border-t'
      } border-line`}
      style={vertical ? { width: size } : { height: size }}
    >
      <div onPointerDown={resizeDock} title="Resize" className={`${dockHandle} z-10 transition hover:bg-primary/40`} />

      {windows.map((definition, index) => (
        <div key={definition.id} className="flex min-h-0 min-w-0 flex-col" style={{ flexGrow: weights[index], flexBasis: 0 }}>
          {index > 0 && (
            <div
              onPointerDown={resizePane(index - 1)}
              title={`Resize ${windows[index - 1].title} and ${definition.title}`}
              className="h-1 shrink-0 cursor-row-resize border-t border-line transition hover:bg-primary/40"
            />
          )}
          <ToolWindowFrame
            definition={definition}
            floating={false}
            onFloat={() => layout.float(definition.id)}
            onDock={() => layout.dock(definition.id)}
            onClose={() => layout.close(definition.id)}
            placement={layout.homeOf(definition.id)}
            onPlace={(anchor) => layout.place(definition.id, anchor)}
          >
            {definition.render({ floating: false, visible: true })}
          </ToolWindowFrame>
        </div>
      ))}
    </div>
  );
}

/** Long enough to read as a drop, short enough that a reflex toggle never feels slow. */
const DROP_MS = 180;

/**
 * The drop console: the `top` anchor, which overlays rather than docks.
 *
 * It hangs above the content and slides down into it, so the conversation underneath keeps its
 * place and its scroll position — you drop the console, do a thing, and dismiss it. Once opened
 * it stays mounted and is moved by a transform, which is what lets it slide *out* as well as in,
 * and means a terminal behind it never has to be reattached.
 */
export function DropConsole({ layout }: { layout: ToolWindowLayout }) {
  const startSize = useRef(0);
  const definition = toolWindows().find((window) => window.anchor === 'top');
  const open = !!definition && layout.layout.active.top.includes(definition.id) && !layout.isFloating(definition.id);
  // Nothing is rendered until the console is first opened; after that it is only ever moved.
  const [used, setUsed] = useState(open);

  useEffect(() => {
    if (open) setUsed(true);
  }, [open]);

  if (!definition || !used) return null;

  const height = layout.layout.size.top;
  const resize = (event: ReactPointerEvent) => {
    startSize.current = height;
    beginDrag(event, ({ dy }) => layout.setDockSize('top', startSize.current + dy));
  };

  return (
    <div
      // Out of the layout entirely: the content below neither moves nor reflows.
      className={`pointer-events-none absolute inset-x-0 top-0 z-30 transition-transform ease-out ${
        open ? 'translate-y-0' : '-translate-y-full'
      }`}
      style={{ height, transitionDuration: `${DROP_MS}ms` }}
      aria-hidden={!open}
      data-preview-occluder={open ? 'true' : undefined}
    >
      <div className="pointer-events-auto relative flex h-full flex-col border-b border-line bg-surface-0/95 shadow-2xl shadow-black/60 backdrop-blur-sm">
        <ToolWindowFrame
          definition={definition}
          floating={false}
          onFloat={() => layout.float(definition.id)}
          onDock={() => layout.dock(definition.id)}
          onClose={() => layout.close(definition.id)}
          placement={layout.homeOf(definition.id)}
          onPlace={(anchor) => layout.place(definition.id, anchor)}
        >
          {definition.render({ floating: false, visible: open })}
        </ToolWindowFrame>
        <div
          onPointerDown={resize}
          title={`Resize ${definition.title}`}
          className="absolute inset-x-0 bottom-0 h-1 cursor-row-resize transition hover:bg-primary/40"
        />
      </div>
    </div>
  );
}

const MIN_FLOAT = { width: 280, height: 180 };

/**
 * Floating tool windows. They are torn out of the dock but stay inside the app window, which is
 * what makes them useful next to a conversation rather than lost behind it: dragged by the title
 * bar, resized from the corner, and raised to the front when clicked.
 */
export function FloatingLayer({ layout }: { layout: ToolWindowLayout }) {
  const origin = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const ids = layout.layout.floating;
  if (!ids.length) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {ids.map((id, index) => {
        const definition = toolWindows().find((window) => window.id === id);
        if (!definition) return null;

        const rect = layout.rect(id);
        const remember = () => {
          origin.current = { ...rect };
        };

        const move = (event: ReactPointerEvent) => {
          layout.focus(id);
          remember();
          beginDrag(event, ({ dx, dy }) =>
            layout.setRect(id, {
              ...origin.current,
              // Keep at least a title bar's worth on screen, or the window becomes unreachable.
              x: Math.min(Math.max(origin.current.x + dx, 8 - rect.width + 80), window.innerWidth - 80),
              y: Math.min(Math.max(origin.current.y + dy, 0), window.innerHeight - 32),
            })
          );
        };

        const resize = (event: ReactPointerEvent) => {
          layout.focus(id);
          remember();
          beginDrag(event, ({ dx, dy }) =>
            layout.setRect(id, {
              ...origin.current,
              width: Math.max(MIN_FLOAT.width, origin.current.width + dx),
              height: Math.max(MIN_FLOAT.height, origin.current.height + dy),
            })
          );
        };

        return (
          <div
            key={id}
            data-floating-tool={id}
            onPointerDown={() => layout.focus(id)}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 40 + index }}
            className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border border-line bg-surface-2 shadow-2xl shadow-black/50 ring-1 ring-black/20"
          >
            <ToolWindowFrame
              definition={definition}
              floating
              onFloat={() => layout.float(id)}
              onDock={() => layout.dock(id)}
              onClose={() => layout.close(id)}
              onDetach={isDetachableToolWindow(id) ? () => layout.detach(id) : undefined}
              onDragStart={move}
              placement={layout.homeOf(id)}
              onPlace={(anchor) => layout.place(id, anchor)}
            >
              {definition.render({ floating: true, visible: true })}
            </ToolWindowFrame>
            <div
              onPointerDown={resize}
              title="Resize"
              className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize border-b-2 border-r-2 border-line-soft"
            />
          </div>
        );
      })}
    </div>
  );
}

export { DOCK_LIMITS };
