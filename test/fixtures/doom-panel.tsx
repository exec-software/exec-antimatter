import { createRoot } from 'react-dom/client';
import { flushDoomSaves } from '../../renderer/src/lib/doomSaves';
import { DoomPanel } from '../../renderer/src/plugins/doom/plugin';
Object.assign(window, { doomSmoke: { flush: flushDoomSaves }, electronAPI: { doom: (window as any).doomFixture } });
createRoot(document.getElementById('root')!).render(<DoomPanel />);
