import { serverSupports } from './server-version.service';

describe('serverSupports', () => {
  it('gates a feature newer than the server', () => {
    expect(serverSupports('5.0.0', '5.1.0')).toBe(false);
    expect(serverSupports('5.1.0', '5.1.0')).toBe(true);
    expect(serverSupports('5.2.3', '5.1.0')).toBe(true);
  });

  it('opens every gate on a dev server', () => {
    expect(serverSupports('5.0.0-dev', '5.1.0')).toBe(true);
  });

  it('lets a pre-release server answer its release', () => {
    expect(serverSupports('5.1.0-beta.1', '5.1.0')).toBe(true);
  });

  it('supports nothing new while the server version is unknown', () => {
    expect(serverSupports(null, '5.1.0')).toBe(false);
  });
});
