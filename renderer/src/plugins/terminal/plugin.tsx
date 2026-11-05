import { SquareTerminal } from 'lucide-react';
import { registerPlugin } from '../registry';
import { TerminalPanel } from './TerminalPanel';

/**
 * Terminal — a console over the conversation.
 *
 * Anchored at the top, where it drops down over the chat and pulls back up out of it: Ctrl+`,
 * run the thing, Ctrl+` again, and the conversation is exactly where you left it. A session
 * picker keeps manual shells and the agent's supervised commands separate and reopenable.
 */
export const terminalPlugin = registerPlugin({
  id: 'antimatter.terminal',
  name: 'Terminal',
  version: '1.0.0',
  description: 'Workspace shells and interactive agent command terminals',
  toolWindows: [
    {
      id: 'terminal.shell',
      title: 'Terminal',
      icon: SquareTerminal,
      anchor: 'top',
      description: 'Workspace shells and agent commands (Ctrl+`)',
      defaultSize: 300,
      floatSize: { width: 760, height: 400 },
      render: ({ visible }) => <TerminalPanel visible={visible} />,
    },
  ],
});
