// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const MARKUP = readFileSync(
  join(process.cwd(), 'apps/extension/src/options/index.html'),
  'utf8',
);

beforeEach(() => {
  document.documentElement.innerHTML = MARKUP;
});

describe('options markup', () => {
  it('carries every hook options.ts reaches for', () => {
    // A renamed id here throws at load and leaves a blank settings page.
    for (const id of [
      'status',
      'form',
      'fields',
      'printer',
      'printer-note',
      'paper-width',
      'printable-width',
      'columns',
      'save',
      'reload',
      'feedback',
    ]) {
      expect(document.getElementById(id), `#${id}`).not.toBeNull();
    }
  });

  it('disables native constraint validation on the form', () => {
    // Regression: with it on, an out-of-range value cancelled the submit event
    // outright, so the page's own validation never ran and the user got no
    // message. All validation belongs in buildPatch.
    const form = document.getElementById('form') as HTMLFormElement;
    expect(form.hasAttribute('novalidate')).toBe(true);
  });

  it('starts with the fields locked, before the host has answered', () => {
    expect((document.getElementById('fields') as HTMLFieldSetElement).disabled).toBe(true);
    expect((document.getElementById('save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('loads no remote resource - manifest V3 CSP', () => {
    expect(MARKUP).not.toMatch(/https?:\/\//);
    expect(MARKUP).not.toContain('<script>');
  });
});
