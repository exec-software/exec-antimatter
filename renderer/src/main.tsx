import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initializeAppearance } from './appearance';
import { initializeDesktopPreferences } from './desktopPreferences';
import './index.css';

initializeAppearance(window.electronAPI?.appearance);
initializeDesktopPreferences(window.electronAPI?.desktop);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
