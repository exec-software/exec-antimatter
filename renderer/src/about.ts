/**
 * The About page's script.
 *
 * Deliberately standalone — no React, no chat bundle — the same dependency-light care the
 * recovery page takes. It only reads what the preload already exposes, fills the page in,
 * and owns the two ways out of the window.
 */
import buildCounter from '../../VERSION?raw';
import { initializeAppearance } from './appearance';

const disposeAppearance = initializeAppearance(window.electronAPI.appearance);
window.addEventListener('unload', disposeAppearance, { once: true });

const info = window.electronAPI.about.info;

const set = (id: string, value: string) => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};

document.title = `About ${info.name}`;
set('product-name', info.name);
set('description', info.description);
// VERSION is the public release; the package identity remains compatible with older updaters.
const build = buildCounter.trim();
set('build', build.startsWith('v') ? build : `v${build}`);
set('release', `Package ${info.version}`);
set('electron', info.electron);
set('chrome', info.chrome);
set('node', info.node);
set('platform', `${info.platform} (${info.architecture})`);
set('copyright', `Copyright © ${info.copyrightYear} Execute Software. All rights reserved.`);

const close = () => void window.electronAPI.about.close();
document.getElementById('close')?.addEventListener('click', close);
document.getElementById('close-chrome')?.addEventListener('click', close);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close();
});

// Poke the core and it runs hot: electrons hurry and the accent glow brightens. It changes nothing but the light — the point is that it reacts.
document.getElementById('core')?.addEventListener('click', () => {
  document.body.classList.toggle('hot');
});

// A fixed main-process destination avoids granting external navigation to the About renderer.
document.getElementById('support')?.addEventListener('click', () => {
  set('support-error', '');
  const about = window.electronAPI.about as typeof window.electronAPI.about & { openSupport(): Promise<void> };
  void about.openSupport().catch(() => set('support-error', 'Could not open the support page. Please try again.'));
});
