import { ClipboardList } from 'lucide-react';
import { registerPlugin } from '../registry';
import { GoeticPanel } from './GoeticPanel';
import { useGoeticBadge } from './store';

/**
 * Goetic — work tracking, brought inside.
 *
 * Goetic is a tracker built for human and agent contributors, and Antimatter is one of those
 * contributors: it holds its own scoped Goetic credential and runs work through the same
 * machine API the panel reads. Bringing it in as a plugin means the person steering an agent and
 * the agent doing the work are looking at one board, in one window, in the same phase vocabulary
 * — rather than a chat here and a browser tab there that disagree by a refresh.
 *
 * The panel deliberately cannot do what Goetic reserves for a browser: it never mints, rotates
 * or re-scopes a credential. What it can do is bounded by whatever scopes that credential holds,
 * which Goetic decides and the Settings tab reports.
 */
export const goeticPlugin = registerPlugin({
  id: 'antimatter.goetic',
  name: 'Goetic',
  version: '1.0.0',
  description: 'Project boards and lifecycle work from Goetic, through a scoped agent credential.',
  toolWindows: [
    {
      id: 'goetic.board',
      title: 'Goetic',
      icon: ClipboardList,
      anchor: 'right',
      description: 'Project boards and lifecycle work',
      defaultSize: 360,
      floatSize: { width: 520, height: 680 },
      useBadge: useGoeticBadge,
      render: ({ visible }) => <GoeticPanel visible={visible} />,
    },
  ],
});
