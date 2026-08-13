import { refusalMessageKey } from './plugin-refusal';

describe('refusalMessageKey', () => {
  it('buckets zip/manifest structural codes as malformed', () => {
    expect(refusalMessageKey('PLUGIN_BAD_MAGIC')).toBe('settings.plugins.consent.refusal.malformed');
    expect(refusalMessageKey('PLUGIN_SYMLINK')).toBe('settings.plugins.consent.refusal.malformed');
  });

  it('buckets size/ratio codes together', () => {
    expect(refusalMessageKey('PLUGIN_TOO_LARGE')).toBe('settings.plugins.consent.refusal.too_large');
    expect(refusalMessageKey('PLUGIN_RATIO')).toBe('settings.plugins.consent.refusal.too_large');
  });

  it('buckets every data-tier field violation together', () => {
    expect(refusalMessageKey('PLUGIN_BAD_UI_CONTRIBUTIONS')).toBe('settings.plugins.consent.refusal.bad_ui_contributions');
    expect(refusalMessageKey('PLUGIN_BAD_EVENTS')).toBe('settings.plugins.consent.refusal.bad_events');
  });

  it('gives signature/hash/tier codes their own message', () => {
    expect(refusalMessageKey('PLUGIN_BAD_SIGNATURE')).toBe('settings.plugins.consent.refusal.bad_signature');
    expect(refusalMessageKey('PLUGIN_UNSIGNED')).toBe('settings.plugins.consent.refusal.unsigned_process');
    expect(refusalMessageKey('PLUGIN_HASH_MISMATCH')).toBe('settings.plugins.consent.refusal.hash_mismatch');
    expect(refusalMessageKey('PLUGIN_FILE_SET_MISMATCH')).toBe('settings.plugins.consent.refusal.file_set_mismatch');
    expect(refusalMessageKey('PLUGIN_TIER_VIOLATION')).toBe('settings.plugins.consent.refusal.tier_violation');
  });

  it('falls back to a generic message for an unknown or missing code', () => {
    expect(refusalMessageKey('PLUGIN_SOME_FUTURE_GUARD')).toBe('settings.plugins.consent.refusal.unknown');
    expect(refusalMessageKey(undefined)).toBe('settings.plugins.consent.refusal.unknown');
  });
});
