import type { AccessMode, RemotePairingOfferView } from '../../types';

const OFFER_ID = /^[A-Za-z0-9_-]{22}$/;
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_QR_DATA_URL_LENGTH = 256 * 1_024;
const ACCESS_MODES = new Set<AccessMode>(['read', 'ask', 'full']);

const incompatibleResponse = (): Error => new Error(
  'Antimatter received an incompatible pairing response. Restart Antimatter and try again.'
);

/**
 * Treat Electron IPC as a version boundary, not as a TypeScript cast. During development an old
 * main or preload process can briefly answer a newly hot-reloaded renderer; keeping that legacy
 * response out of React state turns the mismatch into a recoverable message instead of a render
 * exception (and prevents a missing QR from looking like a valid pairing surface).
 */
export function parseRemotePairingOffer(value: unknown): RemotePairingOfferView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw incompatibleResponse();
  const candidate = value as Record<string, unknown>;
  const capabilities = candidate.capabilities;

  if (
    typeof candidate.id !== 'string' ||
    !OFFER_ID.test(candidate.id) ||
    typeof candidate.endpoint !== 'string' ||
    !candidate.endpoint.startsWith('https://') ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    candidate.expiresAt <= 0 ||
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.length > 8 ||
    !capabilities.every((capability) => typeof capability === 'string' && capability.length > 0) ||
    typeof candidate.maxAccess !== 'string' ||
    !ACCESS_MODES.has(candidate.maxAccess as AccessMode) ||
    typeof candidate.qrDataUrl !== 'string' ||
    candidate.qrDataUrl.length > MAX_QR_DATA_URL_LENGTH ||
    !PNG_DATA_URL.test(candidate.qrDataUrl)
  ) {
    throw incompatibleResponse();
  }

  return {
    id: candidate.id,
    endpoint: candidate.endpoint,
    expiresAt: candidate.expiresAt,
    capabilities: [...capabilities],
    maxAccess: candidate.maxAccess as AccessMode,
    qrDataUrl: candidate.qrDataUrl,
  };
}
