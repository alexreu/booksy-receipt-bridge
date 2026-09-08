/**
 * Comparing versions, without a dependency.
 *
 * Only what this project publishes needs to be understood: `major.minor.patch`
 * with an optional pre-release suffix. Anything unparseable compares as "not
 * newer", so a malformed tag on a release can never make the host offer an
 * update it cannot reason about.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Present for 1.2.3-beta.1; a pre-release is older than its release. */
  prerelease?: string;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION.exec(value.trim());
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

/** -1, 0 or 1, comparing a against b. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const left = a.prerelease;
  const right = b.prerelease;
  if (left === right) return 0;
  // A release outranks any pre-release of the same numbers.
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left < right ? -1 : 1;
}

/**
 * Is `candidate` newer than `current`?
 *
 * False for anything it cannot parse, on either side. Offering an update on the
 * strength of a tag nobody can read is worse than offering none.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parsedCandidate = parseVersion(candidate);
  const parsedCurrent = parseVersion(current);
  if (parsedCandidate === undefined || parsedCurrent === undefined) return false;
  return compareVersions(parsedCandidate, parsedCurrent) > 0;
}
