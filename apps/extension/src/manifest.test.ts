import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Invariants of the extension manifest.
 *
 * The manifest is the extension's security surface - its permissions, its host
 * permissions, the key that pins its id - and it is hand-written rather than
 * generated so it stays reviewable as a plain diff. These assertions are what
 * keep a hand edit from shipping something that a review would have caught.
 */
const ROOT = join(process.cwd(), 'apps/extension');

interface Manifest {
  manifest_version: number;
  name: string;
  version: string;
  key?: string;
  default_locale?: string;
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: unknown[];
  background?: { service_worker?: string; type?: string };
  action?: { default_popup?: string };
  options_ui?: { page?: string; open_in_tab?: boolean };
  content_security_policy?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(join(ROOT, 'manifest.json'), 'utf8'),
) as Manifest;

function exists(relative: string): boolean {
  try {
    readFileSync(join(ROOT, relative));
    return true;
  } catch {
    return false;
  }
}

describe('extension manifest', () => {
  it('is manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('pins the extension id with a key', () => {
    // Without it the id changes on every reload in unpacked mode, and the
    // native host manifest lists exact origins - wildcards are forbidden.
    expect(typeof manifest.key).toBe('string');
    expect((manifest.key ?? '').length).toBeGreaterThan(300);
  });

  it('declares only the permissions the code uses', () => {
    // Plan section 41. `downloads` for the finished-download watcher,
    // `storage` for the detected receipts, and `activeTab` to read and fetch
    // the PDF the user is looking at - granted per click, so no site is listed
    // in host_permissions at all.
    expect(manifest.permissions).toEqual([
      'nativeMessaging',
      'storage',
      'downloads',
      'activeTab',
    ]);
  });

  it('requests no host permissions yet, and never a wildcard', () => {
    // Plan section 42: no *://*/* . Booksy domains arrive in phase 8.
    for (const pattern of manifest.host_permissions ?? []) {
      expect(pattern).not.toContain('*://*/*');
      expect(pattern).not.toBe('<all_urls>');
    }
  });

  it('declares no content script at all', () => {
    // The receipt is a PDF in a tab, reached through activeTab from the popup,
    // so the extension never runs code in a site's page.
    expect(manifest.content_scripts ?? []).toEqual([]);
  });

  it('asks for no host permissions', () => {
    // Plan section 42, at its strictest: activeTab is granted per user click,
    // which is all this needs.
    expect(manifest.host_permissions ?? []).toEqual([]);
  });

  it('points at files the build actually emits', () => {
    // A path typo here loads as an extension with a dead service worker, and
    // the only symptom is a popup that never answers.
    const serviceWorker = manifest.background?.service_worker;
    expect(serviceWorker).toBeDefined();
    expect(exists(join('src', 'background', 'index.ts'))).toBe(true);
    expect(serviceWorker).toBe('background/index.js');

    expect(manifest.action?.default_popup).toBe('popup/index.html');
    expect(exists(join('src', 'popup', 'index.html'))).toBe(true);
  });

  it('points at an options page that exists', () => {
    expect(manifest.options_ui?.page).toBe('options/index.html');
    expect(exists(join('src', 'options', 'index.html'))).toBe(true);
  });

  it('uses an ES module service worker', () => {
    expect(manifest.background?.type).toBe('module');
  });

  it('does not claim a default_locale without a _locales tree', () => {
    // Chrome refuses to load the extension outright: "Default locale was
    // specified, but _locales subtree is missing." The UI strings are French
    // literals, so there is no _locales tree to point at.
    if (manifest.default_locale !== undefined) {
      expect(exists(join('_locales', manifest.default_locale, 'messages.json'))).toBe(true);
    }
  });

  it('keeps the version in step with the host', () => {
    const host = JSON.parse(
      readFileSync(join(process.cwd(), 'apps/native-host/package.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe(host.version);
  });
});
