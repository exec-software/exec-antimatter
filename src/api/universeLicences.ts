/**
 * Licences for expansions.
 *
 * Every universe that ships today is included, so nothing here currently stands between anyone
 * and their work. It exists now anyway, because the alternative — bolting entitlement on once
 * something is for sale — is how applications end up asking the network for permission to open a
 * file the person already has. Writing it first fixes the shape while the stakes are nil:
 *
 * - **Offline by construction.** A grant is a signed file. Verification is a signature check
 *   against a key compiled into the application. There is no server to reach, so there is no
 *   state in which a working licence stops working because something else is down.
 * - **It gates the universe, not the work.** An expired grant closes the workbench. It never
 *   touches the documents, the media or the weights, all of which are the person's. Re-licensing
 *   restores access to material that was never taken away.
 * - **One check, one place.** Entitlement is resolved here and carried as a verdict. No panel
 *   gets to decide for itself whether it is allowed to draw, which is what keeps a half-licensed
 *   state from existing.
 *
 * The signature covers a canonical serialization rather than the file bytes, so a grant can be
 * pretty-printed, re-indented or copied through a form that reflows it and still verifies. What
 * is signed is the meaning, not the whitespace.
 */

export type LicenceEdition =
  /** Shipped with the application. No grant file, no expiry, nothing to lose. */
  | 'included'
  /** Time-limited, for evaluating an expansion. */
  | 'trial'
  /** One person, their machines. */
  | 'personal'
  /** A named organisation and a seat count. */
  | 'studio';

export const LICENCE_EDITIONS: readonly LicenceEdition[] = Object.freeze(['included', 'trial', 'personal', 'studio']);

/**
 * A grant: what was licensed, to whom, until when, and the signature over all of it.
 *
 * `keyId` names which signing key to check against rather than the key itself — a grant that
 * carried its own key would verify against whatever it brought with it, which is not a check.
 */
export interface LicenceGrant {
  version: 1;
  /** The universe this grant is for. */
  universeId: string;
  /** The name the licence is issued to, shown in the licence manager so it is checkable by eye. */
  holder: string;
  edition: LicenceEdition;
  /** ISO. */
  issuedAt: string;
  /** ISO, or null for a perpetual grant. */
  expiresAt: string | null;
  seats: number;
  /** The expansion release this grant covers up to, or null for any. */
  throughRelease: string | null;
  keyId: string;
  /** base64 Ed25519 over `canonicalGrant`. */
  signature: string;
}

/** Why a universe is or is not open. The reason is carried so the page can say it out loud. */
export type EntitlementState =
  /** Open: built in, included, or a valid grant. */
  | 'granted'
  /** A grant that verified but whose date has passed. */
  | 'expired'
  /** A grant that did not verify, or that is for something else. */
  | 'invalid'
  /** A licensed universe with no grant installed. */
  | 'absent';

export interface Entitlement {
  universeId: string;
  state: EntitlementState;
  /** Shown to the person. Written to be read by someone who is not a programmer. */
  reason: string;
  /** The grant behind a `granted`, `expired` or `invalid` verdict, when there was one. */
  grant: LicenceGrant | null;
  /** Days left, for a grant that has an expiry and has not reached it. */
  daysRemaining: number | null;
}

export const isOpen = (entitlement: Entitlement): boolean => entitlement.state === 'granted';

const str = (value: unknown, limit: number): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

const iso = (value: unknown): string | null => {
  const text = str(value, 64);
  if (!text) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};

/**
 * The bytes a signature covers.
 *
 * Field order is fixed here and must never be sorted, derived from `Object.keys`, or otherwise
 * made to depend on how the object was built: every existing grant would stop verifying. The
 * signature field itself is excluded, for the obvious reason.
 */
export function canonicalGrant(grant: LicenceGrant): string {
  return JSON.stringify([
    'antimatter-universe-licence',
    grant.version,
    grant.universeId,
    grant.holder,
    grant.edition,
    grant.issuedAt,
    grant.expiresAt,
    grant.seats,
    grant.throughRelease,
    grant.keyId,
  ]);
}

/** Parse a grant from a file, or reject it. A grant that cannot be read is not a grant. */
export function normalizeGrant(value: unknown): LicenceGrant | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<LicenceGrant> | null;
  if (!source) return null;
  const universeId = str(source.universeId, 64);
  const issuedAt = iso(source.issuedAt);
  const signature = str(source.signature, 512);
  const keyId = str(source.keyId, 64);
  if (!universeId || !issuedAt || !signature || !keyId) return null;
  if (!LICENCE_EDITIONS.includes(source.edition as LicenceEdition)) return null;
  const seats = typeof source.seats === 'number' && Number.isFinite(source.seats) ? Math.floor(source.seats) : 0;
  return {
    version: 1,
    universeId,
    holder: str(source.holder, 120) || 'Unnamed',
    edition: source.edition as LicenceEdition,
    issuedAt,
    expiresAt: iso(source.expiresAt),
    seats: Math.min(Math.max(seats, 1), 10_000),
    throughRelease: str(source.throughRelease, 32) || null,
    keyId,
    signature,
  };
}

/** Whoever checks a signature. Supplied by the caller so this module imports nothing. */
export type VerifySignature = (payload: string, signature: string, keyId: string) => boolean;

const DAY = 86_400_000;

/**
 * Resolve what a universe is entitled to, given its kind and whatever grant was installed.
 *
 * The order matters and is the policy: a built-in or included universe never consults a grant at
 * all. That is not an optimisation — it means a corrupt or expired grant file sitting on disk
 * can never close a universe that was free, which is exactly the failure that makes people
 * distrust licensing.
 */
export function resolveEntitlement(
  universeId: string,
  kind: 'built-in' | 'included' | 'licensed',
  grant: LicenceGrant | null,
  verify: VerifySignature,
  now: number = Date.now(),
  release?: string
): Entitlement {
  if (kind === 'built-in') {
    return { universeId, state: 'granted', reason: 'Part of Antimatter.', grant: null, daysRemaining: null };
  }
  if (kind === 'included') {
    return { universeId, state: 'granted', reason: 'Included with this release.', grant: null, daysRemaining: null };
  }
  if (!grant) {
    return { universeId, state: 'absent', reason: 'No licence is installed for this expansion.', grant: null, daysRemaining: null };
  }
  if (grant.universeId !== universeId) {
    return { universeId, state: 'invalid', reason: `This licence is for ${grant.universeId}, not ${universeId}.`, grant, daysRemaining: null };
  }
  if (!verify(canonicalGrant(grant), grant.signature, grant.keyId)) {
    return { universeId, state: 'invalid', reason: 'This licence could not be verified. Ask whoever issued it for a fresh copy.', grant, daysRemaining: null };
  }
  if (release && grant.throughRelease && compareRelease(release, grant.throughRelease) > 0) {
    return {
      universeId,
      state: 'invalid',
      reason: `This licence covers releases up to ${grant.throughRelease}; this expansion is ${release}.`,
      grant,
      daysRemaining: null,
    };
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= now) {
      return { universeId, state: 'expired', reason: `This licence ended on ${grant.expiresAt.slice(0, 10)}.`, grant, daysRemaining: 0 };
    }
    const daysRemaining = Math.max(0, Math.ceil((expiry - now) / DAY));
    return { universeId, state: 'granted', reason: `Licensed to ${grant.holder}.`, grant, daysRemaining };
  }
  return { universeId, state: 'granted', reason: `Licensed to ${grant.holder}.`, grant, daysRemaining: null };
}

/** Dotted numeric comparison, with anything unparseable treated as 0 rather than throwing. */
export function compareRelease(left: string, right: string): number {
  const parts = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
