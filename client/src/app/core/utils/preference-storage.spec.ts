import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  platform: 'ios',
  vault: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => m.platform, isNativePlatform: () => false },
  registerPlugin: () => m.vault,
}));

type Mod = typeof import('./preference-storage');
let mod: Mod;

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  m.platform = 'ios';
  m.vault.get.mockResolvedValue({});
  m.vault.set.mockResolvedValue(undefined);
  vi.resetModules();
  mod = await import('./preference-storage');
});

describe('sessions on iOS', () => {
  it('reads and writes the vault, never Preferences or localStorage', async () => {
    m.vault.get.mockResolvedValue({ value: 'blob' });
    expect(await mod.readPreference('fliks_sessions')).toBe('blob');
    expect(await mod.writePreference('fliks_sessions', 'next')).toBe(true);
    expect(m.vault.set).toHaveBeenCalledWith({ key: 'fliks_sessions', value: 'next' });
    expect(localStorage.getItem('fliks_sessions')).toBeNull();
  });

  it('does not fall back to localStorage when the vault write fails', async () => {
    m.vault.set.mockRejectedValue(new Error('keychain'));
    expect(await mod.writePreference('fliks_sessions', 'x')).toBe(false);
    expect(localStorage.getItem('fliks_sessions')).toBeNull();
  });

  it('rejects a failed vault read instead of reading it as empty', async () => {
    m.vault.get.mockRejectedValue(new Error('keychain'));
    localStorage.setItem('fliks_sessions', 'stale');
    await expect(mod.readPreference('fliks_sessions')).rejects.toThrow();
  });

  it('moves a leftover localStorage copy into an empty vault once, then removes it', async () => {
    localStorage.setItem('fliks_sessions', 'old');
    expect(await mod.readPreference('fliks_sessions')).toBe('old');
    expect(m.vault.set).toHaveBeenCalledWith({ key: 'fliks_sessions', value: 'old' });
    expect(localStorage.getItem('fliks_sessions')).toBeNull();
  });

  it('keeps the vault copy over a leftover and still removes the leftover', async () => {
    m.vault.get.mockResolvedValue({ value: 'vault' });
    localStorage.setItem('fliks_sessions', 'old');
    expect(await mod.readPreference('fliks_sessions')).toBe('vault');
    expect(m.vault.set).not.toHaveBeenCalled();
    expect(localStorage.getItem('fliks_sessions')).toBeNull();
  });
});

describe('other keys and platforms', () => {
  it('keeps the other keys out of the vault on iOS', async () => {
    await mod.writePreference('fliks_server', 'https://s');
    expect(await mod.readPreference('fliks_server')).toBe('https://s');
    expect(m.vault.get).not.toHaveBeenCalled();
    expect(m.vault.set).not.toHaveBeenCalled();
  });

  it('keeps the sessions out of the vault on Android', async () => {
    m.platform = 'android';
    await mod.writePreference('fliks_sessions', 'blob');
    expect(await mod.readPreference('fliks_sessions')).toBe('blob');
    expect(m.vault.get).not.toHaveBeenCalled();
  });
});
