import { resolveTrust } from './trust-store';
import { generateTestKeypair, signManifestBase64 } from './ed25519-test-keys';

describe('resolveTrust()', () => {
  const data = Buffer.from(JSON.stringify({ id: 'fliks.test', version: '1.0.0' }));

  it('is unsigned when no signature is present', () => {
    expect(resolveTrust(data, null).trust).toBe('unsigned');
  });

  it('an empty trust store resolves a validly-signed archive to unverified, not official, and does not throw', () => {
    const { privateKey } = generateTestKeypair();
    const signature = Buffer.from(signManifestBase64(privateKey, data), 'base64');
    expect(() => resolveTrust(data, signature)).not.toThrow();
    const result = resolveTrust(data, signature);
    expect(result.trust).toBe('unverified');
    expect(result.signedByKeyId).toBeUndefined();
  });

  it('resolves to official when the signer is a compiled-in official key', () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const signature = Buffer.from(signManifestBase64(privateKey, data), 'base64');
    const officialKeys = new Map([['release-2026', rawPublicKey]]);
    const result = resolveTrust(data, signature, officialKeys);
    expect(result.trust).toBe('official');
    expect(result.signedByKeyId).toBe('release-2026');
  });

  it('resolves to verified-<keyId> for a third-party key that is not official', () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const signature = Buffer.from(signManifestBase64(privateKey, data), 'base64');
    const thirdPartyKeys = new Map([['admin-added-key', rawPublicKey]]);
    const result = resolveTrust(data, signature, new Map(), thirdPartyKeys);
    expect(result.trust).toBe('verified-admin-added-key');
    expect(result.signedByKeyId).toBe('admin-added-key');
  });

  it('prefers an official match over an incidental third-party match', () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const signature = Buffer.from(signManifestBase64(privateKey, data), 'base64');
    const officialKeys = new Map([['release-2026', rawPublicKey]]);
    const thirdPartyKeys = new Map([['admin-added-key', rawPublicKey]]);
    const result = resolveTrust(data, signature, officialKeys, thirdPartyKeys);
    expect(result.trust).toBe('official');
  });

  it('a tampered signature against a known key falls through to unverified, never official', () => {
    const { privateKey, rawPublicKey } = generateTestKeypair();
    const signature = Buffer.from(signManifestBase64(privateKey, data), 'base64');
    signature[0] ^= 0xff; // flip a bit — the signature no longer verifies
    const officialKeys = new Map([['release-2026', rawPublicKey]]);
    const result = resolveTrust(data, signature, officialKeys);
    expect(result.trust).toBe('unverified');
  });
});
