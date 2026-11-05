import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../renderer/src/App';
import { initializeAppearance } from '../../renderer/src/appearance';

// The real desktop component and preload API; the smoke host owns only synthetic IPC services.
initializeAppearance(window.electronAPI.appearance);
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
