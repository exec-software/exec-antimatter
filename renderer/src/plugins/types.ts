import type { ComponentType, ReactNode } from 'react';
import type { AppPage, ProviderConfig } from '../types';

/**
 * What a plugin may contribute to the Antimatter shell.
 *
 * The unit is the tool window, borrowed from JetBrains because the behaviour is worth copying:
 * an icon on a stripe at the edge of the window, a panel that slides out over the side it is
 * anchored to, and the freedom to tear that panel off and leave it floating. A plugin declares
 * one and never has to know which of those states it is being rendered in.
 */

/**
 * Where a tool window lives.
 *
 * Three of these dock: they take space from the main area and push it aside. `top` is the
 * exception and is deliberately different — it drops *over* the content like a Quake console,
 * because the thing you want from a panel at the top edge is to dip into it, do something, and
 * have your place back, not to spend the rest of the session with the conversation shorter.
 *
 * The two band sides are the strip either side of the composer. They are not edges of the window
 * but the space flanking a prompt that is deliberately held to a readable measure — dead weight on
 * a laptop and acres of it on an ultrawide. Widgets put there sit under the conversation and beside
 * what you are typing, which is where a thing you want to watch while you work belongs.
 */
export type ToolWindowAnchor = 'left' | 'right' | 'bottom' | 'top' | 'band-left' | 'band-right';

export const BAND_SIDES = ['band-left', 'band-right'] as const;
export type BandSide = (typeof BAND_SIDES)[number];
export const isBandSide = (anchor: ToolWindowAnchor): anchor is BandSide =>
  anchor === 'band-left' || anchor === 'band-right';

/**
 * How a band side arranges the widgets in it.
 *
 * `vertical` and `horizontal` divide the side evenly along one axis; `grid` fills it with
 * equal cells that reflow with the width; `hex` tiles a honeycomb, which wastes a little space
 * at the edges in exchange for reading as a dashboard rather than a list.
 */
export const BAND_ARRANGEMENTS = ['vertical', 'horizontal', 'grid', 'hex'] as const;
export type BandArrangement = (typeof BAND_ARRANGEMENTS)[number];

/**
 * A tool window can ask the shell's shared Model Library to choose a model for something other
 * than the foreground chat. The callback stays inside the renderer; provider credentials never
 * cross this boundary.
 */
export interface ModelSelectionRequest {
  providerId?: string | null;
  modelId?: string | null;
  title: string;
  description?: string;
  actionLabel?: string;
  selectedLabel?: string;
  onSelect(providerId: string, modelId: string): void;
}

/**
 * What the shell hands a tool window about the app around it — the host API, and the only way a
 * plugin is supposed to reach the rest of Antimatter. It is deliberately small: what the user is
 * looking at, what model is answering, and the two things a panel needs to do to the shell.
 */
export interface ShellContextValue {
  /** The directory chat tools are pointed at, when the user has chosen one. */
  workspace: string | null;
  /** The conversation on screen, so a tool window can act on what the user is looking at. */
  conversation: { id: string; title: string; transcript(): string } | null;
  /** Inference sources, and the one the open conversation is using. */
  sources: { providers: ProviderConfig[]; activeProviderId: string; activeModelId: string };
  selectProvider(id: string): void;
  openPage(page: AppPage): void;
  /** Open the card-based Model Library, optionally returning the choice to this tool window. */
  openModelLibrary(request?: ModelSelectionRequest): void;
  /** Append a review request to the current chat's draft; sending remains the user's action. */
  draftReview?(prompt: string, workspace?: string): void;
}

export interface ToolWindowProps {
  floating: boolean;
  /**
   * False while the window is mounted but off screen. Only the drop console can be in that
   * state — every other anchor unmounts what it hides — and a panel that polls should stop
   * while this is false.
   */
  visible: boolean;
}

export interface ToolWindowDef {
  id: string;
  /** Shown in the tool window header and, rotated, on the stripe button. */
  title: string;
  icon: ComponentType<{ size?: number | string; className?: string }>;
  anchor: ToolWindowAnchor;
  /** One line, shown as the stripe button's tooltip. */
  description?: string;
  /** Docked width (left/right) or height (bottom), in pixels. */
  defaultSize?: number;
  /** Starting size of the floating window. */
  floatSize?: { width: number; height: number };
  /**
   * A count to show on the stripe button — how many items are in flight, how many problems
   * there are. Called as a hook from the button, so it may use state and effects.
   */
  useBadge?: () => number | null;
  render(props: ToolWindowProps): ReactNode;
}

export interface AntimatterPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  toolWindows: ToolWindowDef[];
}
