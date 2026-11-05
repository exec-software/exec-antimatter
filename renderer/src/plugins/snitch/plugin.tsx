import { Bug, Zap } from 'lucide-react';
import { registerPlugin } from '../registry';
import { SnitchPanel } from './SnitchPanel';
import { PipelinePanel } from './PipelinePanel';
import { usePipelineCount } from './store';

/**
 * Snitch — Antimatter's first plugin.
 *
 * It is the exec-snitch concept brought inside: multi-project issue and request tracking, kept
 * in the same YAML-and-Markdown files, with the piece a standalone tracker cannot have — the
 * agent that fixes the bug is already here, so filing one and dispatching it are the same panel.
 */
export const snitchPlugin = registerPlugin({
  id: 'antimatter.snitch',
  name: 'Snitch',
  version: '1.0.0',
  description: 'Multi-project issues and requests, with one-click fixes through the orchestrator.',
  toolWindows: [
    {
      id: 'snitch.items',
      title: 'Snitch',
      icon: Bug,
      anchor: 'right',
      description: 'Issues and requests across your projects',
      defaultSize: 340,
      floatSize: { width: 480, height: 620 },
      useBadge: usePipelineCount,
      render: () => <SnitchPanel />,
    },
    {
      id: 'snitch.pipeline',
      title: 'Fixes',
      icon: Zap,
      anchor: 'bottom',
      description: 'What the fix pipeline is working on',
      defaultSize: 260,
      floatSize: { width: 720, height: 380 },
      useBadge: usePipelineCount,
      render: () => <PipelinePanel />,
    },
  ],
});
