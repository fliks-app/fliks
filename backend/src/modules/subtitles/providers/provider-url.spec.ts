import { providerUrl } from './provider-url';

const BASE = 'https://dl.subdl.com';

describe('providerUrl', () => {
  it('VERDICT: a userinfo-style path can no longer move the request off-host', () => {
    // `${BASE}${id}` produced https://dl.subdl.com@attacker.tld/x — the host
    // was attacker.tld. Resolving keeps it a path on the provider instead.
    const url = providerUrl(BASE, '@attacker.tld/x');

    expect(new URL(url).origin).toBe(BASE);
  });

  it('refuses an absolute URL pointing elsewhere', () => {
    expect(() => providerUrl(BASE, 'https://attacker.tld/x')).toThrow(/attacker\.tld/);
    expect(() => providerUrl(BASE, '//attacker.tld/x')).toThrow(/attacker\.tld/);
    expect(() => providerUrl(BASE, 'file:///etc/passwd')).toThrow();
  });

  it('keeps an absolute URL on the provider itself', () => {
    expect(providerUrl(BASE, `${BASE}/a/b.zip`)).toBe(`${BASE}/a/b.zip`);
  });

  it('resolves the ordinary relative path unchanged', () => {
    expect(providerUrl(BASE, '/subtitle/123.zip')).toBe(`${BASE}/subtitle/123.zip`);
  });
});
