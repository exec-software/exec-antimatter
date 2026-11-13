import { isDetachableToolWindow } from '../../../src/api/detachedWindows';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findToolWindow, toolWindowsAt } from './registry';
import {
  BAND_ARRANGEMENTS, BAND_SIDES, isBandSide,
  type BandArrangement, type BandSide, type ToolWindowAnchor, type ToolWindowDef,
} from './types';
import { desktopPlatform, useDesktopPreferences } from '../desktopPreferences';
import { matchesShortcut } from '../../../src/api/desktopPreferences';

/**
 * Where every tool window is, and how big.
 *
 * One docked window is visible per anchor at a time, exactly like a JetBrains stripe: clicking
 * the icon that is already showing puts it away. A window that is floating has left its anchor
 * entirely and lives in the floating layer until it is docked again.
 *
 * The whole thing is one serialisable object so the layout survives a reload; it is a per-machine
 * preference, so a storage failure costs the arrangement and nothing else.
 */

export interface FloatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutState {
  /**
   * The docked windows on screen for each anchor, in order, or empty when that side is
   * collapsed. More than one means the side is split between them — which is the point: a task
   * list is worth nothing if watching it costs you sight of the agent it is listing.
   */
  active: Record<ToolWindowAnchor, string[]>;
  /** Docked extent per anchor: width for left and right, height for top and bottom. */
  size: Record<ToolWindowAnchor, number>;
  /** How a split anchor divides its extent — one weight per open window, in the same order. */
  splits: Record<ToolWindowAnchor, number[]>;
  /** Floating window ids, bottom of the stack first. */
  floating: string[];
  /**
   * Tool windows that are detached into their own OS windows. The main process owns the
   * BrowserWindow; the renderer only tracks which ids are detached and persists the bounds.
   */
  detached: string[];
  /** OS window geometry for detached windows (bounds persisted across sessions). */
  detachedGeometry: Record<string, FloatRect>;
  geometry: Record<string, FloatRect>;
  /**
   * Where the user has put a window, overriding the anchor its plugin declared. A declared
   * anchor is only a default now: a panel is worth no less beside the prompt than at the edge,
   * and nothing shipped with `anchor: 'left'`, so that side stood empty while the band had
   * nothing to offer either.
   */
  placement: Record<string, ToolWindowAnchor>;
  /** How each band side arranges what is in it. */
  arrangement: Record<BandSide, BandArrangement>;
  /** The band is one row, so its height belongs to the row and not to either side. */
  bandHeight: number;
}

const STORAGE_KEY = 'antimatter.toolWindows';

export const DOCK_LIMITS: Record<ToolWindowAnchor, { min: number; max: number }> = {
  left: { min: 220, max: 560 },
  right: { min: 260, max: 720 },
  bottom: { min: 140, max: 640 },
  top: { min: 140, max: 720 },
  // A band side's width is whatever the prompt leaves over, so only the row's height is set here.
  'band-left': { min: 96, max: 560 },
  'band-right': { min: 96, max: 560 },
};

export const BAND_HEIGHT_LIMITS = { min: 96, max: 560 };

const DEFAULT_LAYOUT: LayoutState = {
  active: { left: [], right: [], bottom: [], top: [], 'band-left': [], 'band-right': [] },
  size: { left: 280, right: 340, bottom: 240, top: 300, 'band-left': 160, 'band-right': 160 },
  splits: { left: [], right: [], bottom: [], top: [], 'band-left': [], 'band-right': [] },
  floating: [],
  detached: [],
  detachedGeometry: {},
  geometry: {},
  placement: {},
  arrangement: { 'band-left': 'grid', 'band-right': 'grid' },
  bandHeight: 160,
};

/** A pane never shrinks below this, whichever way the anchor runs. */
export const MIN_PANE_PX = 110;

/** Layouts written before splitting stored one id per anchor; read those as a stack of one. */
const asStack = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : typeof value === 'string' ? [value] : [];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function load(): LayoutState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(stored) as Partial<LayoutState>;
    const active = { ...DEFAULT_LAYOUT.active };
    for (const anchor of Object.keys(active) as ToolWindowAnchor[]) {
      active[anchor] = asStack((parsed.active as Record<string, unknown> | undefined)?.[anchor]);
    }
    const splits = { ...DEFAULT_LAYOUT.splits };
    for (const anchor of Object.keys(splits) as ToolWindowAnchor[]) {
      const stored_ = (parsed.splits as Record<string, unknown> | undefined)?.[anchor];
      // Weights that no longer match the stack are meaningless; fall back to an even split.
      splits[anchor] = Array.isArray(stored_) && stored_.length === active[anchor].length
        ? (stored_ as number[])
        : active[anchor].map(() => 1);
    }
    // A layout written before the band knew nothing of these keys; read it as the defaults.
    const placement: Record<string, ToolWindowAnchor> = {};
    for (const [id, anchor] of Object.entries((parsed.placement ?? {}) as Record<string, unknown>)) {
      if (typeof anchor === 'string' && anchor in DEFAULT_LAYOUT.active) placement[id] = anchor as ToolWindowAnchor;
    }
    const arrangement = { ...DEFAULT_LAYOUT.arrangement };
    for (const side of BAND_SIDES) {
      const stored = (parsed.arrangement as Record<string, unknown> | undefined)?.[side];
      if (typeof stored === 'string' && (BAND_ARRANGEMENTS as readonly string[]).includes(stored)) {
        arrangement[side] = stored as BandArrangement;
      }
    }
    return {
      active,
      size: { ...DEFAULT_LAYOUT.size, ...(parsed.size ?? {}) },
      splits,
      floating: Array.isArray(parsed.floating) ? parsed.floating : [],
      detached: Array.isArray(parsed.detached) ? [...new Set(parsed.detached.filter(isDetachableToolWindow))] : [],
      detachedGeometry: parsed.detachedGeometry ?? {},
      geometry: parsed.geometry ?? {},
      placement,
      arrangement,
      bandHeight: typeof parsed.bandHeight === 'number' && Number.isFinite(parsed.bandHeight)
        ? clamp(Math.round(parsed.bandHeight), BAND_HEIGHT_LIMITS.min, BAND_HEIGHT_LIMITS.max)
        : DEFAULT_LAYOUT.bandHeight,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** A new floating window lands near the middle, stepped so a second one does not hide the first. */
function defaultRect(definition: ToolWindowDef, taken: number): FloatRect {
  const width = definition.floatSize?.width ?? 460;
  const height = definition.floatSize?.height ?? 420;
  const step = (taken % 6) * 28;
  return {
    x: Math.max(24, Math.round((window.innerWidth - width) / 2) + step),
    y: Math.max(24, Math.round((window.innerHeight - height) / 3) + step),
    width,
    height,
  };
}

export interface ToolWindowLayout {
  layout: LayoutState;
  /** Where this window lives: what the user chose, else what its plugin declared. */
  homeOf(id: string): ToolWindowAnchor;
  /** Move a window to an anchor, docking it there even if it was floating. */
  place(id: string, anchor: ToolWindowAnchor): void;
  arrangementAt(side: BandSide): BandArrangement;
  setArrangement(side: BandSide, arrangement: BandArrangement): void;
  setBandHeight(height: number): void;
  /** The docked windows for an anchor, in order. Empty when that side is collapsed. */
  dockedAt(anchor: ToolWindowAnchor): ToolWindowDef[];
  /** The share of the anchor's extent each open window gets, same order as dockedAt. */
  sharesAt(anchor: ToolWindowAnchor): number[];
  /** Drags the divider between pane `index` and the one after it. */
  setSplit(anchor: ToolWindowAnchor, index: number, weights: number[]): void;
  isOpen(id: string): boolean;
  isFloating(id: string): boolean;
  isDetached(id: string): boolean;
  toggle(id: string): void;
  close(id: string): void;
  float(id: string): void;
  /** Detach a window into its own OS window. */
  detach(id: string): Promise<void>;
  /** Dock a window from a detached OS window back into the main window. */
  dockDetached(id: string): void;
  dock(id: string): void;
  focus(id: string): void;
  setDockSize(anchor: ToolWindowAnchor, size: number): void;
  setRect(id: string, rect: FloatRect): void;
  rect(id: string): FloatRect;
}

/**
 * Show a tool window without rearranging it.
 *
 * The difference between this and `float` is who is asking. A person who drags a window out of its
 * anchor has decided where it should live. A turn that has just run a command has not — and it used
 * to call `float` anyway, which detaches the window: a console the person had docked was pulled into
 * the floating layer by every command a model ran, so docking it lasted until the next one and
 * docking it at all was impossible.
 *
 * So the arrangement is left alone. A floating window is raised, a docked one stays exactly where it
 * is, and one that was put away comes back at its own anchor rather than in front of everything.
 */
export function revealToolWindow(layout: Pick<ToolWindowLayout, 'isOpen' | 'toggle' | 'focus'>, id: string): void {
  if (!layout.isOpen(id)) layout.toggle(id);
  else layout.focus(id);
}

export function useToolWindowLayout(): ToolWindowLayout {
  const desktopPreferences = useDesktopPreferences();
  const [layout, setLayout] = useState<LayoutState>(load);
  const latest = useRef(layout);
  latest.current = layout;
  const pendingDetach = useRef(new Map<string, { cancelled: boolean; promise: Promise<void> }>());
  const closeDetached = useCallback((id: string) => {
    const pending = pendingDetach.current.get(id);
    if (pending) pending.cancelled = true;
    if (pending || latest.current.detached.includes(id)) void window.electronAPI.detached.close(id).catch(console.error);
  }, []);

  /** A declared anchor is the default; a placement the user chose wins. */
  const homeIn = (state: LayoutState, id: string): ToolWindowAnchor =>
    state.placement[id] ?? findToolWindow(id)?.anchor ?? 'right';
  const homeOf = useCallback((id: string) => homeIn(layout, id), [layout]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Storage unavailable: the arrangement lasts for this session only.
    }
  }, [layout]);

  const isFloating = useCallback((id: string) => layout.floating.includes(id), [layout.floating]);

  const isDetached = useCallback((id: string) => layout.detached.includes(id), [layout.detached]);

  const isOpen = useCallback(
    (id: string) => layout.floating.includes(id) || layout.detached.includes(id) || Object.values(layout.active).some((stack) => stack.includes(id)),
    [layout]
  );

  /** Takes a window out of whatever anchor holds it, keeping the other panes' weights.
   *  Named apart from `detach`/`dock`, which move a window between this window and an OS one. */
  const unanchor = (state: LayoutState, id: string): LayoutState => {
    const anchor = (Object.keys(state.active) as ToolWindowAnchor[]).find((key) => state.active[key].includes(id));
    if (!anchor) return state;

    const index = state.active[anchor].indexOf(id);
    return {
      ...state,
      active: { ...state.active, [anchor]: state.active[anchor].filter((entry) => entry !== id) },
      splits: { ...state.splits, [anchor]: state.splits[anchor].filter((_, position) => position !== index) },
    };
  };

  const close = useCallback((id: string) => {
    closeDetached(id);
    setLayout((prev) => ({ ...unanchor(prev, id), floating: prev.floating.filter((entry) => entry !== id), detached: prev.detached.filter((entry) => entry !== id) }));
  }, [closeDetached]);

  const focus = useCallback((id: string) => {
    if (latest.current.detached.includes(id)) void window.electronAPI.detached.focus(id).catch(console.error);
    setLayout((prev) =>
      prev.floating.includes(id) && prev.floating[prev.floating.length - 1] !== id
        ? { ...prev, floating: [...prev.floating.filter((entry) => entry !== id), id] }
        : prev
    );
  }, []);

  const toggle = useCallback((id: string) => {
    if (latest.current.detached.includes(id)) { close(id); return; }
    const definition = findToolWindow(id);
    if (!definition) return;

    setLayout((prev) => {
      if (prev.floating.includes(id)) {
        return { ...prev, floating: prev.floating.filter((entry) => entry !== id) };
      }
      const home = homeIn(prev, id);
      // Already showing: put it away. Otherwise it joins the anchor, splitting it with whatever
      // is already there rather than replacing it.
      if (prev.active[home].includes(id)) return unanchor(prev, id);

      return {
        ...prev,
        active: { ...prev.active, [home]: [...prev.active[home], id] },
        splits: { ...prev.splits, [home]: [...prev.splits[home], 1] },
        size: {
          ...prev.size,
          // A band side is sized by the row's height, so a window's own width never applies.
          [home]: definition.defaultSize && !isBandSide(home)
            ? Math.max(prev.size[home], definition.defaultSize)
            : prev.size[home],
        },
      };
    });
  }, [close]);

  const float = useCallback((id: string) => {
    const definition = findToolWindow(id);
    if (!definition) return;
    closeDetached(id);
    setLayout((prev) => {
      const without = unanchor(prev, id);
      return {
        ...without, detached: without.detached.filter((entry) => entry !== id),
        floating: without.floating.includes(id) ? without.floating : [...without.floating, id],
        geometry: without.geometry[id] ? without.geometry : { ...without.geometry, [id]: defaultRect(definition, without.floating.length) },
      };
    });
  }, [closeDetached]);

  const dockState = (prev: LayoutState, id: string): LayoutState => {
    const without = unanchor(prev, id);
    const home = homeIn(prev, id);
    return { ...without, floating: without.floating.filter((entry) => entry !== id), detached: without.detached.filter((entry) => entry !== id),
      active: { ...without.active, [home]: [...without.active[home], id] },
      splits: { ...without.splits, [home]: [...without.splits[home], 1] } };
  };
  const dock = useCallback((id: string) => {
    if (!findToolWindow(id)) return;
    closeDetached(id);
    setLayout((prev) => dockState(prev, id));
  }, [closeDetached]);

  /** Keep the original panel visible until its OS window has actually loaded. */
  const detach = useCallback((id: string): Promise<void> => {
    const definition = findToolWindow(id);
    if (!definition || !isDetachableToolWindow(id)) return Promise.reject(new Error('This panel cannot be detached.'));
    const existing = pendingDetach.current.get(id);
    if (existing) return existing.promise;
    const state = latest.current;
    const bounds = state.detachedGeometry[id] ?? { ...defaultRect(definition, state.detached.length), x: window.screenX + 60, y: window.screenY + 60 };
    const pending = { cancelled: false, promise: Promise.resolve() };
    pending.promise = window.electronAPI.detached.create(id, bounds).then((created) => {
      if (pending.cancelled) { void window.electronAPI.detached.close(id).catch(console.error); return; }
      setLayout((prev) => ({ ...unanchor(prev, id), floating: prev.floating.filter((entry) => entry !== id),
        detached: [...prev.detached.filter((entry) => entry !== id), id],
        detachedGeometry: { ...prev.detachedGeometry, [id]: created.bounds } }));
    }).finally(() => { if (pendingDetach.current.get(id) === pending) pendingDetach.current.delete(id); });
    pendingDetach.current.set(id, pending);
    return pending.promise;
  }, []);
  const dockDetached = useCallback((id: string) => {
    void window.electronAPI.detached.dock(id).catch(console.error);
  }, []);

  /**
   * Send a window to an anchor. It is taken out of wherever it was first, so moving between two
   * band sides cannot leave it listed on both, and the placement is remembered so toggling it
   * off and on again brings it back to the side the user chose rather than the plugin's default.
   */
  const place = useCallback((id: string, anchor: ToolWindowAnchor) => {
    if (!findToolWindow(id)) return;

    closeDetached(id);
    setLayout((prev) => {
      const without = unanchor(prev, id);
      return {
        ...without,
        detached: without.detached.filter((entry) => entry !== id),
        placement: { ...without.placement, [id]: anchor },
        floating: without.floating.filter((entry) => entry !== id),
        active: { ...without.active, [anchor]: [...without.active[anchor].filter((e) => e !== id), id] },
        splits: { ...without.splits, [anchor]: [...without.splits[anchor], 1] },
      };
    });
  }, [closeDetached]);

  const arrangementAt = useCallback((side: BandSide) => layout.arrangement[side], [layout.arrangement]);

  const setArrangement = useCallback((side: BandSide, arrangement: BandArrangement) => {
    setLayout((prev) => ({ ...prev, arrangement: { ...prev.arrangement, [side]: arrangement } }));
  }, []);

  const setBandHeight = useCallback((height: number) => {
    setLayout((prev) => ({
      ...prev,
      bandHeight: clamp(Math.round(height), BAND_HEIGHT_LIMITS.min, BAND_HEIGHT_LIMITS.max),
    }));
  }, []);

  const setDockSize = useCallback((anchor: ToolWindowAnchor, size: number) => {
    const { min, max } = DOCK_LIMITS[anchor];
    setLayout((prev) => ({ ...prev, size: { ...prev.size, [anchor]: clamp(Math.round(size), min, max) } }));
  }, []);

  const setRect = useCallback((id: string, rect: FloatRect) => {
    setLayout((prev) => ({ ...prev, geometry: { ...prev.geometry, [id]: rect } }));
  }, []);

  /**
   * Ctrl+` drops the console — the key Quake gave everyone the reflex for, and the one most
   * editors kept for the same job. Bound in the capture phase so it still works while the
   * terminal has focus and would otherwise swallow it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('[data-hotkey-recorder]')) return;
      if (!matchesShortcut(event, desktopPreferences.hotkeys.terminal, desktopPlatform())) return;

      const console_ = toolWindowsAt('top')[0];
      if (!console_) return;

      event.preventDefault();
      event.stopPropagation();
      toggle(console_.id);
    };

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggle, desktopPreferences.hotkeys.terminal]);

  const dockedAt = useCallback(
    (anchor: ToolWindowAnchor) =>
      layout.active[anchor]
        .filter((id) => !layout.floating.includes(id) && !layout.detached.includes(id))
        .map((id) => findToolWindow(id))
        .filter((definition): definition is ToolWindowDef => !!definition),
    [layout]
  );

  const sharesAt = useCallback(
    (anchor: ToolWindowAnchor) => {
      const weights = layout.splits[anchor];
      return layout.active[anchor].map((_, index) => weights[index] ?? 1);
    },
    [layout]
  );

  const setSplit = useCallback((anchor: ToolWindowAnchor, _index: number, weights: number[]) => {
    setLayout((prev) => ({ ...prev, splits: { ...prev.splits, [anchor]: weights } }));
  }, []);

  const rect = useCallback(
    (id: string) => layout.geometry[id] ?? defaultRect(findToolWindow(id) ?? ({} as ToolWindowDef), 0),
    [layout.geometry]
  );

  useEffect(() => {
    const api = window.electronAPI.detached;
    const stopBounds = api.onBounds(({ toolWindowId, bounds }) => {
      setLayout((prev) => ({ ...prev, detachedGeometry: { ...prev.detachedGeometry, [toolWindowId]: bounds } }));
    });
    const stopChanges = api.onChanged(({ toolWindowId, bounds, kind }) => {
      if (kind === 'opened') return; // create() commits only after successful load.
      const pending = pendingDetach.current.get(toolWindowId);
      if (pending) pending.cancelled = true;
      setLayout((prev) => {
        const next = { ...prev, detached: prev.detached.filter((id) => id !== toolWindowId), detachedGeometry: { ...prev.detachedGeometry, [toolWindowId]: bounds } };
        return kind === 'docked' ? dockState(next, toolWindowId) : next;
      });
    });
    for (const id of latest.current.detached) {
      void detach(id).catch((error: unknown) => { console.error('Could not restore detached panel:', error); setLayout((prev) => dockState(prev, id)); });
    }
    return () => { stopBounds(); stopChanges(); };
  }, [detach]);

  return useMemo(
    () => ({ layout, homeOf, place, arrangementAt, setArrangement, setBandHeight, dockedAt, sharesAt, setSplit,
      isOpen, isFloating, isDetached, toggle, close, float, dock, detach, dockDetached, focus, setDockSize, setRect, rect }),
    [layout, homeOf, place, arrangementAt, setArrangement, setBandHeight, dockedAt, sharesAt, setSplit,
      isOpen, isFloating, isDetached, toggle, close, float, dock, detach, dockDetached, focus, setDockSize, setRect, rect]
  );
}
