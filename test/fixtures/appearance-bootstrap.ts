import { getAppearance, initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import type { AppearanceAPI, ReadonlyAppearanceAPI } from '../../src/api/appearance';

const host = window as unknown as {
  electronAPI?: { appearance: AppearanceAPI };
  desktopAvatar?: { appearance: ReadonlyAppearanceAPI };
  bootstrapSmoke?: unknown;
};
const bridge = host.electronAPI?.appearance ?? host.desktopAvatar?.appearance;
const read = () => ({
  surface: getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
  primary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(),
  accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
  scheme: getComputedStyle(document.documentElement).colorScheme,
  body: getComputedStyle(document.body).backgroundColor,
  inlineSurface: document.documentElement.style.getPropertyValue('--color-surface'),
  current: getAppearance(),
});
host.bootstrapSmoke = {
  // Deliberately capture before initializing the controller: only the real preload can color this.
  before: { ...read(), initial: bridge?.initial, hasUpdate: !!bridge && 'update' in bridge },
  start: () => initializeAppearance(bridge),
  read,
  save: saveAppearance,
};
