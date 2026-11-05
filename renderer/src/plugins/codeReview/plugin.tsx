import { FileCheck2 } from 'lucide-react';
import { registerPlugin } from '../registry';
import { CodeReviewPanel } from './CodeReviewPanel';

export const codeReviewPlugin = registerPlugin({
  id: 'antimatter.code-review',
  name: 'Code Review',
  version: '1.0.0',
  description: 'Shared code snapshots, findings, and conversations with your agent.',
  toolWindows: [{
    id: 'code-review.workspace',
    title: 'Code Review',
    icon: FileCheck2,
    anchor: 'right',
    description: 'Review code together, discuss findings, and verify fixes',
    defaultSize: 480,
    floatSize: { width: 1000, height: 720 },
    render: () => <CodeReviewPanel />,
  }],
});
