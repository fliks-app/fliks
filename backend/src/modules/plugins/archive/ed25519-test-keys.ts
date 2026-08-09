import { generateKeyPairSync, sign as ed25519Sign, KeyObject } from 'crypto';

export interface TestKeypair {
  privateKey: KeyObject;
  /** Raw 32-byte public key — the format {@link resolveTrust} stores keys in. */
  rawPublicKey: Buffer;
}

/** A fresh Ed25519 keypair for signature-path specs. Never used outside tests. */
export function generateTestKeypair(): TestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return { privateKey, rawPublicKey: spki.subarray(spki.length - 32) };
}

/** Base64 text — exactly what a `plugin.json.sig` entry's file content holds. */
export function signManifestBase64(privateKey: KeyObject, manifestBytes: Buffer): string {
  return ed25519Sign(null, manifestBytes, privateKey).toString('base64');
}
