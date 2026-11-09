import { compareVersions } from './semver';

describe('compareVersions', () => {
  it.each([
    ['0.4.0', '0.3.3', 1],
    ['0.10.0', '0.9.9', 1],
    ['1.0.0', '1.0.0', 0],
    ['1.0.0-beta.2', '1.0.0', -1],
    ['1.0.0-beta.10', '1.0.0-beta.2', 1],
    ['1.0.0-alpha', '1.0.0-1', 1],
    ['1.0.0+build', '1.0.0', 0],
  ])('%s vs %s is %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(-expected || 0);
  });
});
