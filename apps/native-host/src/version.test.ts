import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOST_VERSION } from './version.ts';

function versionOf(relative: string): string {
  const manifest = JSON.parse(
    readFileSync(new URL(relative, import.meta.url), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

describe('HOST_VERSION', () => {
  it('matches this package', () => {
    // The constant exists because a bundled single-file host has no
    // package.json to read; this keeps the two from drifting apart.
    expect(HOST_VERSION).toBe(versionOf('../package.json'));
  });

  it('matches the workspace root, which is what a release is tagged from', () => {
    // Checking only this package let a bump at the root produce a binary
    // announcing the previous version. The release caught it - after building
    // for three platforms, which is a slow way to learn it.
    expect(HOST_VERSION).toBe(versionOf('../../../package.json'));
  });
});
