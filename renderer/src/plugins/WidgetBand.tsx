import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Columns3, Grid2x2, Hexagon, Rows3 } from 'lucide-react';
import { ToolWindowFrame } from './chrome';
import type { ToolWindowLayout } from './layout';
import { BAND_ARRANGEMENTS, type BandArrangement, type BandSide, type ToolWindowDef } from './types';

/**
 * The strip either side of the composer, and the row that holds all three.
 *
 * The prompt is held to a readable measure, which leaves the space beside it doing nothing: a
 * heavy empty band on a laptop, and a great deal of nothing on an ultrawide. That space is the
 * band. Widgets put in it sit under the conversation and beside what you are typing, and the row
 * drags upward when you want more of them.
 *
 * The row draws the only top edge, so the composer no longer contributes a second line at a
 * content-dependent height -- which is what made it sit out of step with the rail's own divider.
 */

/**
 * Rows of a honeycomb, alternating full and short so the tiles interlock.
 *
 * Pure and exported so the tiling is checked directly: the geometry is the part worth testing,
 * and it is much easier to assert on row sizes than on clip paths.
 */
export function honeycombRows(count: number, perRow: number): number[] {
  if (count <= 0) return [];
  const wide = Math.max(1, Math.floor(perRow));
  // A short row needs at least one tile, so a single-column band degenerates to a plain stack.
  const narrow = Math.max(1, wide - 1);
  const rows: number[] = [];
  let remaining = count;
  let full = true;
  while (remaining > 0) {
    const take = Math.min(remaining, full ? wide : narrow);
    rows.push(take);
    remaining -= take;
    full = !full;
  }
  return rows;
}

const HEX_CLIP = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';

const ARRANGEMENT_ICON: Record<BandArrangement, typeof Grid2x2> = {
  vertical: Rows3,
  horizontal: Columns3,
  grid: Grid2x2,
  hex: Hexagon,
};

const ARRANGEMENT_LABEL: Record<BandArrangement, string> = {
  vertical: 'Stack',
  horizontal: 'Side by side',
  grid: 'Grid',
  hex: 'Honeycomb',
};

function Tile({ definition, layout, clip }: { definition: ToolWindowDef; layout: ToolWindowLayout; clip?: boolean }) {
  return (
    <div
      className={`min-h-0 min-w-0 overflow-hidden border border-line bg-surface-2 ${clip ? '' : 'rounded-lg'}`}
      style={clip ? { clipPath: HEX_CLIP, borderRadius: 0 } : undefined}
    >
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
  );
}

function Arranged({ side, layout }: { side: BandSide; layout: ToolWindowLayout }) {
  const windows = layout.dockedAt(side);
  const arrangement = layout.arrangementAt(side);

  if (arrangement === 'hex') {
    // Tiles are a fixed size here: a honeycomb only reads as one when every cell matches, so the
    // band shows as many as fit and the row's height decides how many courses are visible.
    const rows = honeycombRows(windows.length, 3);
    let taken = 0;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-start gap-0 overflow-auto py-1">
        {rows.map((count, row) => {
          const slice = windows.slice(taken, taken + count);
          taken += count;
          return (
            <div key={row} className="flex shrink-0 gap-1" style={{ marginTop: row === 0 ? 0 : '-1.75rem' }}>
              {slice.map((definition) => (
                <div key={definition.id} className="h-[8.5rem] w-[7.5rem] shrink-0">
                  <Tile definition={definition} layout={layout} clip />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  if (arrangement === 'grid') {
    return (
      <div
        className="grid min-h-0 min-w-0 flex-1 gap-1.5 overflow-auto"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gridAutoRows: 'minmax(0, 1fr)' }}
      >
        {windows.map((definition) => <Tile key={definition.id} definition={definition} layout={layout} />)}
      </div>
    );
  }

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 gap-1.5 ${arrangement === 'vertical' ? 'flex-col' : 'flex-row'}`}>
      {windows.map((definition) => (
        <div key={definition.id} className="min-h-0 min-w-0 flex-1">
          <Tile definition={definition} layout={layout} />
        </div>
      ))}
    </div>
  );
}

function SidePanel({ side, layout }: { side: BandSide; layout: ToolWindowLayout }) {
  const windows = layout.dockedAt(side);
  const arrangement = layout.arrangementAt(side);
  const label = side === 'band-left' ? 'Left widgets' : 'Right widgets';

  return (
    <section aria-label={label} className="group/band relative flex min-w-0 flex-1 flex-col p-1.5">
      {windows.length === 0 ? (
        // Nothing docked: say so quietly rather than leaving a slab of empty surface, which is
        // what made this area read as dead weight in the first place.
        <p className="m-auto max-w-[14rem] text-balance text-center text-[11px] leading-4 text-ink-3 opacity-0 transition group-hover/band:opacity-100">
          Dock a panel here from its title bar to watch it while you work.
        </p>
      ) : (
        <Arranged side={side} layout={layout} />
      )}

      {/* The arrangement picker only matters once something is in the side, and only on hover. */}
      {windows.length > 1 && (
        <div
          role="group"
          aria-label={`${label} arrangement`}
          className={`absolute ${side === 'band-left' ? 'left-1.5' : 'right-1.5'} top-0.5 flex gap-0.5 rounded-md border border-line bg-surface-3/95 p-0.5 opacity-0 transition group-hover/band:opacity-100 focus-within:opacity-100`}
        >
          {BAND_ARRANGEMENTS.map((option) => {
            const Icon = ARRANGEMENT_ICON[option];
            return (
              <button
                key={option}
                type="button"
                aria-pressed={arrangement === option}
                title={ARRANGEMENT_LABEL[option]}
                aria-label={ARRANGEMENT_LABEL[option]}
                onClick={() => layout.setArrangement(side, option)}
                className={`rounded p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  arrangement === option ? 'bg-primary/15 text-primary' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'
                }`}
              >
                <Icon size={11} />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

interface BandProps {
  layout: ToolWindowLayout;
  /** The composer, centred between the two sides. */
  children: ReactNode;
}

export function WidgetBand({ layout, children }: BandProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  /** Dragging the row's top edge upward gives the widgets more height. */
  const resize = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = rowRef.current?.getBoundingClientRect().height ?? layout.layout.bandHeight;
    const move = (moved: PointerEvent) => layout.setBandHeight(startHeight + (startY - moved.clientY));
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
  };

  return (
    <div ref={rowRef} className="relative shrink-0 border-t border-line bg-surface-2" style={{ minHeight: layout.layout.bandHeight }}>
      <div
        onPointerDown={resize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the widget band"
        title="Drag to resize"
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize transition hover:bg-primary/40"
      />
      <div className="flex h-full items-stretch">
        <SidePanel side="band-left" layout={layout} />
        {/* Held to the same measure the bar used, so the prompt does not move when the band
            appears, and stays centred because both sides flex equally. */}
        <div className="flex w-full max-w-3xl min-w-0 shrink flex-col justify-end">{children}</div>
        <SidePanel side="band-right" layout={layout} />
      </div>
    </div>
  );
}

/**
 * Where the prompt lives: in the band, or floating over the conversation.
 *
 * Both arms render the same composer, so the choice is only about what is around it. Floating
 * costs the widget sides, which is the trade the setting describes: a prompt that reads as one
 * object on a laptop, against space you can put to work on an ultrawide.
 */
export function PromptSurface({ docked, layout, children }: { docked: boolean; layout: ToolWindowLayout; children: ReactNode }) {
  if (docked) return <WidgetBand layout={layout}>{children}</WidgetBand>;

  return (
    // Click-through everywhere but the card itself, so the conversation under it stays usable.
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      <div className="w-full max-w-3xl">{children}</div>
    </div>
  );
}
