import { pathToFileURL } from 'node:url';

export function isVoiceAppUrl(url: string, appEntry: string, devUrl?: string): boolean {
  try {
    const parsed = new URL(url); parsed.hash = ''; parsed.search = '';
    if (parsed.username || parsed.password) return false;
    if (devUrl) {
      const dev = new URL(devUrl);
      return ['http:', 'https:'].includes(dev.protocol) && parsed.origin === dev.origin && (parsed.pathname === '/' || parsed.pathname === '/index.html');
    }
    return parsed.href === pathToFileURL(appEntry).href;
  } catch { return false; }
}

export function mayCaptureVoice(input: { trustedMain: boolean; active: boolean; mainFrame: boolean; mediaTypes: readonly string[] }): boolean {
  return input.trustedMain && input.active && input.mainFrame && input.mediaTypes.length === 1 && input.mediaTypes[0] === 'audio';
}
