import { Bot, ListTodo } from 'lucide-react';
import { registerPlugin } from '../registry';
import { AgentsPanel } from './AgentsPanel';
import { TasksPanel } from './TasksPanel';
import { useActiveCount } from './store';

/**
 * Orchestration: the roster and the queue.
 *
 * Two tool windows rather than one, both anchored right, because they answer different questions
 * and the right side can now hold both at once. The roster is configuration — who exists, what
 * they are for. The queue is what is happening. Splitting them is the point: you watch the queue
 * while you edit an agent, which is impossible in a sidebar that only holds one thing.
 */
export const agentsPlugin = registerPlugin({
  id: 'antimatter.agents',
  name: 'Agents',
  version: '1.0.0',
  description: 'Specialised agents, the tasks they are given, and the sessions they leave behind.',
  toolWindows: [
    {
      id: 'agents.tasks',
      title: 'Tasks',
      icon: ListTodo,
      anchor: 'right',
      description: 'Queued, running and scheduled work',
      defaultSize: 340,
      floatSize: { width: 520, height: 640 },
      useBadge: useActiveCount,
      render: () => <TasksPanel />,
    },
    {
      id: 'agents.roster',
      title: 'Agents',
      icon: Bot,
      anchor: 'right',
      description: 'The agents installed, and what each is for',
      defaultSize: 320,
      floatSize: { width: 480, height: 620 },
      render: () => <AgentsPanel />,
    },
  ],
});
