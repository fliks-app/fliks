import { createPublicKey, verify as verifyDetached } from 'crypto';

/**
 * Official release keys, raw 32-byte Ed25519 public keys keyed by key id.
 * Empty until Phase 8.1 (`fliks-plugin-catalog`) mints the first signing
 * key: populate with `OFFICIAL_KEYS.set('<keyId>', Buffer.from('<base64>', 'base64'))`.
 * An empty store must never resolve a signature to `official` — see {@link resolveTrust}.
 */
export const OFFICIAL_KEYS: ReadonlyMap<string, Buffer> = new Map([
  // fliks-app/fliks-plugin-catalog signs its catalog and every first-party
  // plugin with this key. Never remove a published key: old signatures must
  // stay verifiable, which is what makes rotation safe.
  [
    'release-2026',
    Buffer.from('Cj0i8YENJdTuC0I0pPPZbNuzo4tgIcpMnCjlb8rtaKs=', 'base64'),
  ],
]);

export type TrustOutcome = 'official' | `verified-${string}` | 'unverified' | 'unsigned';

export interface SignatureVerification {
  trust: TrustOutcome;
  signedByKeyId?: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Wrap a raw 32-byte Ed25519 public key in the DER/SPKI envelope `crypto.createPublicKey` requires. */
function rawEd25519ToSpki(raw: Buffer): Buffer {
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

function verifyWithRawKey(data: Buffer, signature: Buffer, rawPublicKey: Buffer): boolean {
  if (rawPublicKey.length !== 32) return false;
  try {
    const keyObject = createPublicKey({
      key: rawEd25519ToSpki(rawPublicKey),
      format: 'der',
      type: 'spki',
    });
    return verifyDetached(null, data, keyObject, signature);
  } catch {
    return false;
  }
}

/**
 * Classify a signature by trying every known key — official first, then
 * caller-supplied third-party keys — never the reverse: an official key
 * always wins the `official` badge over an incidental third-party match.
 * No signature at all is `unsigned`. A signature nothing recognises is
 * `unverified` — including the case where both stores are empty, which
 * must never crash and must never read as `official`.
 */
export function resolveTrust(
  data: Buffer,
  signature: Buffer | null,
  officialKeys: ReadonlyMap<string, Buffer> = OFFICIAL_KEYS,
  thirdPartyKeys: ReadonlyMap<string, Buffer> = new Map(),
): SignatureVerification {
  if (!signature) return { trust: 'unsigned' };
  for (const [keyId, rawKey] of officialKeys) {
    if (verifyWithRawKey(data, signature, rawKey)) return { trust: 'official', signedByKeyId: keyId };
  }
  for (const [keyId, rawKey] of thirdPartyKeys) {
    if (verifyWithRawKey(data, signature, rawKey)) {
      return { trust: `verified-${keyId}`, signedByKeyId: keyId };
    }
  }
  return { trust: 'unverified' };
}
