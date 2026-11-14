/**
 * Loading the plugins. Importing this module is what puts them in the registry, so the shell
 * imports it once and then only ever talks to the registry.
 */
import './agents/plugin';
import './builtin/sources';
import './goetic/plugin';
import './snitch/plugin';
import './terminal/plugin';
import './preview/plugin';
import './vitals/plugin';
import './codeReview/plugin';
import './replyPad/plugin';
import './doom/plugin';

export { listPlugins, toolWindows, toolWindowsAt, findToolWindow, registerPlugin } from './registry';
export { revealToolWindow, useToolWindowLayout, type ToolWindowLayout } from './layout';
export { Dock, DropConsole, FloatingLayer, ToolStripe } from './ToolWindowHost';
export { WidgetBand, PromptSurface, honeycombRows } from './WidgetBand';
export { ShellProvider, useShell } from './shell';
export type {
  AntimatterPlugin,
  BandArrangement,
  BandSide,
  ModelSelectionRequest,
  ShellContextValue,
  ToolWindowAnchor,
  ToolWindowDef,
} from './types';
export { BAND_ARRANGEMENTS, BAND_SIDES, isBandSide } from './types';
