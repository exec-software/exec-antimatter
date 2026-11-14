import type { ToolDef } from '../types';
import { desktopTools } from './desktop';
import { fileTools } from './files';
import { gitTools } from './git';
import { goeticTools } from './goetic';
import { imageTools } from './images';
import { recoveryTools } from './recovery';
import { securityTools } from './security';
import { shellTools } from './shell';
import { webTools } from './web';

/** Every tool Antimatter's own MCP server exposes, in the order they are listed to the model. */
export const ALL_TOOLS: ToolDef[] = [
  ...fileTools,
  ...gitTools,
  ...goeticTools,
  ...securityTools,
  ...shellTools,
  ...desktopTools,
  ...imageTools,
  ...webTools,
  ...recoveryTools,
];

export const toolsByName = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));
