import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOST_VERSION } from './version.ts';

describe('HOST_VERSION', () => {
  it('matches the package version', () => {
    // The constant exists because a bundled single-file host has no
    // package.json to read; this keeps the two from drifting apart.
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(HOST_VERSION).toBe(manifest.version);
  });
});
