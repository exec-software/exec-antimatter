import { createRoot } from 'react-dom/client';
import { initializeAppearance } from './appearance';
import './plugins';
import { DetachedToolWindow } from './plugins/detached/DetachedToolWindow';
import './index.css';

initializeAppearance(window.electronAPI.appearance);
const container = document.getElementById('root');
if (container) createRoot(container).render(<DetachedToolWindow />);
