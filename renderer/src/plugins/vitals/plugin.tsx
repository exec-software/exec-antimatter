import { Activity } from 'lucide-react';
import { registerPlugin } from '../registry';
import { VitalsPanel } from './VitalsPanel';

/**
 * Vitals — what the machine underneath is doing.
 *
 * An agent that compiles, runs tests and holds a local model resident makes the difference
 * between "thinking" and "the box is out of memory" worth being able to see without leaving the
 * window.
 */
export const vitalsPlugin = registerPlugin({
  id: 'antimatter.vitals',
  name: 'Vitals',
  version: '1.0.0',
  description: 'CPU, memory, GPU, temperatures and disks',
  toolWindows: [
    {
      id: 'vitals.monitor',
      title: 'Vitals',
      icon: Activity,
      anchor: 'right',
      description: 'System health at a glance',
      defaultSize: 320,
      floatSize: { width: 420, height: 680 },
      render: () => <VitalsPanel />,
    },
  ],
});
