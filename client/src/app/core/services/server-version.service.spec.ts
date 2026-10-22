import { serverSupports } from './server-version.service';

describe('serverSupports', () => {
  it('gates a feature newer than the server', () => {
    expect(serverSupports('5.0.0', '5.1.0', '5.1.0')).toBe(false);
    expect(serverSupports('5.1.0', '5.1.0', '5.2.0')).toBe(true);
    expect(serverSupports('5.2.3', '5.1.0', '5.2.0')).toBe(true);
  });

  it('lets an unreleased app through when the server is as new as the app', () => {
    expect(serverSupports('5.0.0', '5.1.0', '5.0.0')).toBe(true);
  });

  it('supports nothing new while the server version is unknown', () => {
    expect(serverSupports(null, '5.1.0', '5.1.0')).toBe(false);
  });
});
