import { grantSatisfies, parsePluginGrant } from './plugin-grant';

/** The `when` a manifest writes, read against what a role actually holds. */
function holds(held: string[], wanted: string): boolean {
  const want = parsePluginGrant(wanted);
  return !!want && held.some((g) => grantSatisfies(g, want));
}

describe('plugin grants', () => {
  it('reads a bare subject as manage', () => {
    expect(parsePluginGrant('plugin:fliks.download:queue')).toEqual({
      action: 'manage',
      subject: 'plugin:fliks.download:queue',
    });
  });

  it('reads the action off a prefixed grant', () => {
    expect(parsePluginGrant('read:plugin:fliks.download:queue')).toEqual({
      action: 'read',
      subject: 'plugin:fliks.download:queue',
    });
  });

  it('is null for anything that is not a plugin grant', () => {
    expect(parsePluginGrant('media.read')).toBeNull();
    expect(parsePluginGrant('manage:all')).toBeNull();
  });

  it('lets manage cover a narrower action, in both spellings', () => {
    expect(holds(['manage:plugin:a:queue'], 'read:plugin:a:queue')).toBe(true);
    expect(holds(['plugin:a:queue'], 'read:plugin:a:queue')).toBe(true);
  });

  it('never lets a narrower action cover manage', () => {
    expect(holds(['read:plugin:a:queue'], 'manage:plugin:a:queue')).toBe(false);
    expect(holds(['read:plugin:a:queue'], 'plugin:a:queue')).toBe(false);
  });

  it('matches an action against itself and never across subjects', () => {
    expect(holds(['read:plugin:a:queue'], 'read:plugin:a:queue')).toBe(true);
    expect(holds(['manage:plugin:a:queue'], 'manage:plugin:a:blocklist')).toBe(false);
    expect(holds(['manage:plugin:b:queue'], 'manage:plugin:a:queue')).toBe(false);
  });
});
