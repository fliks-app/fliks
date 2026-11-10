import { SERVER_SINCE, serverSupports } from './server-version.service';

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

describe('SERVER_SINCE', () => {
  it('hides every unreleased route from the last release and opens it from the next', () => {
    for (const since of Object.values(SERVER_SINCE)) {
      expect(serverSupports('6.0.2', since)).toBe(false);
      expect(serverSupports('6.1.0', since)).toBe(true);
    }
  });
});
