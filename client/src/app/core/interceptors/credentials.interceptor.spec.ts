import { targetsActiveServer } from './credentials.interceptor';

describe('targetsActiveServer', () => {
  it('accepts relative API paths', () => {
    expect(targetsActiveServer('/api/auth/me', '')).toBe(true);
    expect(targetsActiveServer('/api/media/1', 'http://tv.lan:3000')).toBe(true);
  });

  it('accepts absolute URLs under the active server', () => {
    expect(
      targetsActiveServer('http://tv.lan:3000/api/auth/me', 'http://tv.lan:3000'),
    ).toBe(true);
  });

  it('refuses a host the user merely typed — the session must not leak to it', () => {
    expect(
      targetsActiveServer('http://evil.example/api/auth/me', 'http://tv.lan:3000'),
    ).toBe(false);
    expect(targetsActiveServer('http://tv.lan:3000/api/auth/me', '')).toBe(false);
  });

  it('ignores anything that is not an API call', () => {
    expect(targetsActiveServer('/i18n/fr.json', '')).toBe(false);
    expect(targetsActiveServer('https://image.tmdb.org/t/p/w500/x.jpg', '')).toBe(false);
  });
});
