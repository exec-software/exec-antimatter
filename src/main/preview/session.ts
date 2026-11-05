import { randomUUID } from 'node:crypto';
import type { Certificate, WebContents } from 'electron';

/** A fresh in-memory partition isolates a replacement from anything its predecessor leaves behind. */
export const nextPreviewPartition = (): string => `antimatter-preview-${randomUUID()}`;

export interface PreventableEvent {
  preventDefault(): void;
}

/** A remote page may not move or resize the Antimatter window that owns its child view. */
export const preventPageWindowMutation = (event: PreventableEvent): void => event.preventDefault();

/**
 * Refuse ambient OS client certificates on the untrusted preview WebContents. Keeping this on the
 * page itself avoids changing certificate policy for Antimatter's trusted application windows.
 */
export function bindPreviewClientCertificateDenial(contents: WebContents): void {
  contents.on('select-client-certificate', (event, _url, _certificates, callback) => {
    event.preventDefault();
    // Electron declines selection when the documented callback is completed without a
    // certificate, although the generated WebContents callback type still requires one.
    (callback as unknown as (certificate?: Certificate) => void)();
  });
}

export interface RetiredPreviewSession {
  clearData(options: { dataTypes: ['serviceWorkers'] }): Promise<void>;
  closeAllConnections(): Promise<void>;
}

/**
 * Unregister stored service workers and cut the retired session's current network connections.
 * Electron does not promise that clearData terminates a worker task that was already executing;
 * the fresh partition above is what prevents any survivor from reaching a replacement preview.
 */
export async function retirePreviewSession(session: RetiredPreviewSession): Promise<void> {
  const results = await Promise.allSettled([
    session.clearData({ dataTypes: ['serviceWorkers'] }),
    session.closeAllConnections(),
  ]);
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, 'Could not completely clean up a web preview session.');
}
