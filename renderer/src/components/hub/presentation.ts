import { useEffect, useState } from 'react';
import { BUNDLED_BEHOLDD_ARCHITECTURES } from '../../../../src/api/beholdd';
import { isBundledNativeSource } from '../../lib/inferenceUx';
import type { HubDownload, ProviderConfig } from '../../types';

export { bytes, rate } from '../../plugins/vitals/format';

/**
 * The architectures the bundled beholdd serves (vendor/beholdd/share/serving.md). The main process
 * decides registration from the file's own header; this only labels a search result.
 */
export const BUNDLED_ARCHITECTURES: ReadonlySet<string> = new Set<string>(BUNDLED_BEHOLDD_ARCHITECTURES);

/** 12834876 → "12.8M". Download counts want a glance, not a digit count. */
export function compact(value: number): string {
  if (value < 1000) return String(value);
  const units = ['K', 'M', 'B'];
  let scaled = value;
  let unit = -1;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${units[unit]}`;
}

/** Parameter counts read as model sizes: 30532122624 → "30.5B", 596049920 → "596M". */
export const parameters = (value: number | null | undefined): string | null =>
  value ? compact(value) : null;

export const contextLabel = (tokens: number | null | undefined): string | null =>
  tokens ? `${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} ctx` : null;

export function relativeDate(iso: string | null): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

export function remaining(bytesLeft: number, bytesPerSecond: number | undefined): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0 || bytesLeft <= 0) return null;
  const seconds = Math.ceil(bytesLeft / bytesPerSecond);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

/** Local beholdd servers other than the bundled one: where any GGUF can be registered by path. */
export const externalBeholdds = (providers: ProviderConfig[]): ProviderConfig[] =>
  providers.filter((provider) => {
    if ((provider.kind ?? 'beholdd') !== 'beholdd' || isBundledNativeSource(provider)) return false;
    try {
      return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(provider.baseUrl).hostname);
    } catch {
      return false;
    }
  });

/** IPC errors arrive wrapped in Electron's "Error invoking remote method" preamble. */
export const errorText = (error: unknown): string =>
  ((error as Error)?.message ?? String(error)).replace(/^Error invoking remote method '[^']+':\s*(\w*Error:\s*)?/, '');

export const isActive = (record: HubDownload) => record.state !== 'ready';

/**
 * Where a finished download can be used right now. A registered GPU source comes before the
 * bundled native one; the two servers can expose the same checkpoint through different runtimes.
 */
export function usableTarget(record: HubDownload, providers: ProviderConfig[]): { providerId: string; modelId: string } | null {
  const usable = record.registrations
    .filter((entry) => entry.status === 'registered' && entry.sourceId && entry.modelId)
    .filter((entry) =>
      providers.some((provider) => provider.id === entry.sourceId && provider.models.some((model) => model.id === entry.modelId))
    )
    .sort((a, b) => (a.target === b.target ? 0 : a.target === 'external' ? -1 : 1));
  const chosen = usable[0];
  return chosen ? { providerId: chosen.sourceId!, modelId: chosen.modelId! } : null;
}

/** The download queue as the main process reports it, kept current by its progress events. */
export function useHubDownloads(): HubDownload[] {
  const [downloads, setDownloads] = useState<HubDownload[]>([]);
  useEffect(() => {
    let heard = false;
    const stop = window.electronAPI.onHubDownloads((records) => {
      heard = true;
      setDownloads(records);
    });
    window.electronAPI.hub
      .downloads()
      .then((records) => {
        // An event that arrived first is newer than this reply.
        if (!heard) setDownloads(records);
      })
      .catch(console.error);
    return stop;
  }, []);
  return downloads;
}
