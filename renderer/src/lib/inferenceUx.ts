const BUNDLED_BEHOLDD_PORT = '6768';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

interface SourceDescriptor {
  id?: string;
  baseUrl: string;
  kind?: string;
}

/** The managed native endpoint may serve CPU or qualified HAG models.
 * Older sources may omit kind; an explicitly different kind or external identity is excluded.
 * The endpoint alone never proves which device executes a particular model.
 */
export function isBundledNativeSource(source: SourceDescriptor): boolean {
  // First-run discovery gives a listener Antimatter did not spawn this stable id. Its hardware
  // and lifecycle are unknown, even though it happens to occupy the bundled server's port.
  if (source.id === 'local-beholdd-external') return false;
  if (source.kind && source.kind !== 'beholdd') return false;

  try {
    const url = new URL(source.baseUrl);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) && url.port === BUNDLED_BEHOLDD_PORT;
  } catch {
    return false;
  }
}

export const sourcePickerLabel = (source: SourceDescriptor & { name: string }): string =>
  isBundledNativeSource(source) ? `${source.name} — native` : source.name;
