import { PanelsTopLeft } from 'lucide-react';
import { registerPlugin } from '../registry';
import { PreviewPanel } from './PreviewPanel';

export const previewPlugin = registerPlugin({
  id: 'antimatter.preview',
  name: 'Preview',
  version: '1.0.0',
  description: 'Embedded websites, local development servers, and workspace images.',
  toolWindows: [{
    id: 'preview.viewer',
    title: 'Preview',
    icon: PanelsTopLeft,
    anchor: 'right',
    description: 'Browse websites and images alongside your conversation',
    defaultSize: 480,
    floatSize: { width: 900, height: 650 },
    render: (props) => <PreviewPanel {...props} />,
  }],
});
