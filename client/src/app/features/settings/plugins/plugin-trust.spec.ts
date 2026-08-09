import { trustBadgeFor, requiresAcknowledgement } from './plugin-trust';

describe('trustBadgeFor', () => {
  it('badges an official signature', () => {
    expect(trustBadgeFor('official')).toEqual({ labelKey: 'settings.plugins.trust.official', cssClass: 'badge-success' });
  });

  it('badges an unsigned archive as manually imported', () => {
    expect(trustBadgeFor('unsigned')).toEqual({ labelKey: 'settings.plugins.trust.manual', cssClass: 'badge-ghost' });
  });

  it('badges an unverified signature, including a missing value', () => {
    expect(trustBadgeFor('unverified').labelKey).toBe('settings.plugins.trust.unverified');
    expect(trustBadgeFor(undefined).labelKey).toBe('settings.plugins.trust.unverified');
  });

  it('extracts the key id from a verified-<key> outcome', () => {
    expect(trustBadgeFor('verified-acme-2026')).toEqual({
      labelKey: 'settings.plugins.trust.verified',
      params: { key: 'acme-2026' },
      cssClass: 'badge-success',
    });
  });
});

describe('requiresAcknowledgement', () => {
  it('requires it for anything without an attributable signature', () => {
    expect(requiresAcknowledgement('unverified')).toBe(true);
    expect(requiresAcknowledgement('unsigned')).toBe(true);
    expect(requiresAcknowledgement(undefined)).toBe(true);
  });

  it('does not require it once a key attributes the signature', () => {
    expect(requiresAcknowledgement('official')).toBe(false);
    expect(requiresAcknowledgement('verified-acme-2026')).toBe(false);
  });
});
