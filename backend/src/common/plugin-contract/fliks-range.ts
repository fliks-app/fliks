import * as semver from 'semver';

/**
 * The version a `fliks` range is matched against: a prerelease resolves as its own release, since
 * `3.0.0-rc.1` sorts *below* `3.0.0` and would otherwise satisfy no range that admits 3.0.0 —
 * leaving a release candidate unable to run any plugin, and the upgrade impossible to rehearse.
 */
export function fliksRangeVersion(version: string): string {
  const parsed = semver.parse(version);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : version;
}
