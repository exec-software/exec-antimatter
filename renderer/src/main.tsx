import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initializeAppearance } from './appearance';
import './index.css';

initializeAppearance(window.electronAPI?.appearance);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
