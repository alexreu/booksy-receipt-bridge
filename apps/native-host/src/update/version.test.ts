import { describe, expect, it } from 'vitest';
import { compareVersions, isNewer, parseVersion } from './version.ts';

describe('parseVersion', () => {
  it('reads a plain version, with or without the v', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion(' v1.2.3 ')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('reads a pre-release suffix', () => {
    expect(parseVersion('1.2.3-beta.1')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: 'beta.1',
    });
  });

  it('refuses anything it cannot read', () => {
    for (const value of ['', 'latest', '1.2', '1.2.3.4', 'v', 'release-1']) {
      expect(parseVersion(value), value).toBeUndefined();
    }
  });
});

describe('compareVersions', () => {
  const v = (value: string): NonNullable<ReturnType<typeof parseVersion>> => {
    const parsed = parseVersion(value);
    if (parsed === undefined) throw new Error(`version de test invalide : ${value}`);
    return parsed;
  };

  it('orders by major, then minor, then patch', () => {
    expect(compareVersions(v('2.0.0'), v('1.9.9'))).toBe(1);
    expect(compareVersions(v('1.3.0'), v('1.2.9'))).toBe(1);
    expect(compareVersions(v('1.2.4'), v('1.2.3'))).toBe(1);
    expect(compareVersions(v('1.2.3'), v('1.2.3'))).toBe(0);
    expect(compareVersions(v('1.2.3'), v('1.2.4'))).toBe(-1);
  });

  it('does not compare numbers as strings', () => {
    // The trap: "10" < "9" lexically.
    expect(compareVersions(v('0.10.0'), v('0.9.0'))).toBe(1);
    expect(compareVersions(v('1.0.10'), v('1.0.9'))).toBe(1);
  });

  it('ranks a release above its own pre-release', () => {
    expect(compareVersions(v('1.2.3'), v('1.2.3-beta.1'))).toBe(1);
    expect(compareVersions(v('1.2.3-beta.1'), v('1.2.3'))).toBe(-1);
    expect(compareVersions(v('1.2.3-beta.2'), v('1.2.3-beta.1'))).toBe(1);
  });
});

describe('isNewer', () => {
  it('says so only for a genuinely newer version', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.0.9', '0.1.0')).toBe(false);
  });

  it('refuses to call an unreadable tag newer', () => {
    // Offering an update on the strength of a tag nobody can parse is worse
    // than offering none.
    expect(isNewer('latest', '0.1.0')).toBe(false);
    expect(isNewer('nightly-2026-09-08', '0.1.0')).toBe(false);
    expect(isNewer('0.2.0', 'inconnue')).toBe(false);
  });
});
