import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { install, inspectSource, uninstall, NATIVE_HOST_NAME } from './install.ts';
import { installDir, installTargets, manifestContent, parseExtensionIds } from './targets.ts';

const ID = 'ndfcmfgnelpdjgpmaelpdgoccmjcpdjm';

let root: string;
let source: string;
let home: string;

/** A delivered archive, minus the 113 MB binary. */
function stageDelivery(): void {
  mkdirSync(join(source, 'pdfjs', 'standard_fonts'), { recursive: true });
  writeFileSync(join(source, 'booksy-receipt-bridge'), '#!/bin/sh\necho 0.0.0\n');
  mkdirSync(join(source, 'extension'), { recursive: true });
  writeFileSync(join(source, 'extension', 'manifest.json'), '{"name":"x"}');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brb-install-'));
  source = join(root, 'delivery');
  home = join(root, 'home');
  mkdirSync(source, { recursive: true });
  mkdirSync(home, { recursive: true });
});

describe('installTargets', () => {
  it('points at the registry on Windows, never at a file', () => {
    const targets = installTargets({ platform: 'win32', home: 'C:\\Users\\x' });
    expect(targets.every((target) => target.kind === 'registry')).toBe(true);
    expect(targets.map((target) => target.location)).toContain(
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    );
    // HKCU, not HKLM: an installation that needs elevation is one a till user
    // cannot perform.
    expect(targets.every((target) => target.location.startsWith('HKCU'))).toBe(true);
  });

  it('points at the browser directories on macOS', () => {
    const targets = installTargets({ platform: 'darwin', home: '/Users/x' });
    expect(targets.map((target) => target.location)).toContain(
      '/Users/x/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    );
  });

  it('honours XDG_CONFIG_HOME on Linux', () => {
    const targets = installTargets({
      platform: 'linux',
      home: '/home/x',
      configHome: '/home/x/ailleurs',
    });
    expect(targets[0]?.location).toBe('/home/x/ailleurs/google-chrome/NativeMessagingHosts');
  });
});

describe('installDir', () => {
  it('stays inside the user profile, spelled for the target platform', () => {
    // Literal separators on both sides: the point is that the answer follows
    // the platform asked about, not the one the test happens to run on.
    expect(installDir({ platform: 'win32', home: 'C:\\Users\\x' }, { LOCALAPPDATA: 'C:\\L' })).toBe(
      'C:\\L\\Programs\\BooksyReceiptBridge',
    );
    expect(installDir({ platform: 'darwin', home: '/Users/x' })).toBe(
      '/Users/x/.local/share/BooksyReceiptBridge',
    );
  });
});

describe('parseExtensionIds', () => {
  it('keeps the ids Chrome could have issued', () => {
    expect(parseExtensionIds(`${ID}, ${ID}`)).toEqual([ID, ID]);
  });

  it('drops what cannot be one, rather than authorising nonsense', () => {
    // A typo reaching the manifest produces a file that authorises nobody, and
    // a popup that blames the service.
    expect(parseExtensionIds('trop-court, ,ZZZZ')).toEqual([]);
  });
});

describe('manifestContent', () => {
  it('lists exact origins, never a wildcard', () => {
    const manifest = manifestContent('com.example', '/bin/x', [ID]);
    expect(manifest['allowed_origins']).toEqual([`chrome-extension://${ID}/`]);
    expect(JSON.stringify(manifest)).not.toContain('*');
  });
});

describe('inspectSource', () => {
  it('refuses a delivery with no font tables', () => {
    // Such an install starts, answers PING, and fails on the first receipt -
    // the worst moment to discover it.
    writeFileSync(join(source, 'booksy-receipt-bridge'), 'x');
    const inspected = inspectSource(source);
    expect('error' in inspected && inspected.error).toContain('pdfjs/standard_fonts');
  });

  it('refuses a folder with no executable', () => {
    const inspected = inspectSource(source);
    expect('error' in inspected && inspected.error).toContain('Aucun exécutable');
  });
});

describe('install', () => {
  it('copies the service and the extension into the profile, and registers', async () => {
    stageDelivery();
    // One browser profile that exists; the others do not.
    mkdirSync(posix.join(home, '.config', 'google-chrome'), { recursive: true });

    const result = await install({
      source,
      home,
      platform: 'linux',
      env: {},
      extensionIds: [ID],
      log: () => undefined,
    });

    expect(result.ok).toBe(true);
    const installed = posix.join(home, '.local/share/BooksyReceiptBridge');
    expect(existsSync(posix.join(installed, 'booksy-receipt-bridge'))).toBe(true);
    expect(result.extensionPath).toBe(posix.join(installed, 'extension'));
    expect(result.registered).toEqual(['Chrome']);

    const written = JSON.parse(
      readFileSync(
        posix.join(home, '.config/google-chrome/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
        'utf8',
      ),
    ) as { path: string; allowed_origins: string[] };
    // The manifest points at the INSTALLED copy, not at the archive the user
    // is about to delete.
    expect(written.path).toBe(posix.join(installed, 'booksy-receipt-bridge'));
    expect(written.allowed_origins).toEqual([`chrome-extension://${ID}/`]);
  });

  it('does not invent a profile for a browser that is absent', async () => {
    stageDelivery();
    const result = await install({
      source,
      home,
      platform: 'linux',
      env: {},
      extensionIds: [ID],
      log: () => undefined,
    });
    expect(result.registered).toEqual([]);
    expect(existsSync(posix.join(home, '.config', 'chromium'))).toBe(false);
  });

  it('refuses to write a manifest that authorises nobody', async () => {
    stageDelivery();
    const result = await install({
      source,
      home,
      platform: 'linux',
      env: {},
      extensionIds: [],
      log: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('identifiant');
  });

  it('recognises the installed copy through a symlinked path', async () => {
    // What running the real binary found: macOS reports /private/tmp for a
    // path the caller spells /tmp, so the installed copy did not look like
    // itself and copying it over itself threw.
    stageDelivery();
    await install({
      source,
      home,
      platform: 'linux',
      env: {},
      extensionIds: [ID],
      log: () => undefined,
    });
    const installed = posix.join(home, '.local/share/BooksyReceiptBridge');
    const viaLink = join(root, 'lien');
    symlinkSync(installed, viaLink);

    const again = await install({
      source: viaLink,
      home,
      platform: 'linux',
      env: {},
      extensionIds: [ID],
      log: () => undefined,
    });

    expect(again).toMatchObject({ ok: true });
    expect(again.error).toBeUndefined();
  });

  it('runs again on the installed copy without copying a file onto itself', async () => {
    // The update case. On Windows that copy fails outright, and there is
    // nothing to copy anyway.
    stageDelivery();
    await install({
      source,
      home,
      platform: 'linux',
      env: {},
      extensionIds: [ID],
      log: () => undefined,
    });
    const installed = posix.join(home, '.local/share/BooksyReceiptBridge');

    const again = await install({
      source: installed,
      home,
      platform: 'linux',
      env: {},
      extensionIds: [ID],
      log: () => undefined,
    });

    expect(again.ok).toBe(true);
    expect(existsSync(posix.join(installed, 'extension', 'manifest.json'))).toBe(true);
  });
});

describe('uninstall', () => {
  it('removes the files and the registrations, and keeps the configuration', async () => {
    stageDelivery();
    mkdirSync(posix.join(home, '.config', 'google-chrome'), { recursive: true });
    await install({
      source,
      home,
      platform: 'linux',
      env: {},
      extensionIds: [ID],
      log: () => undefined,
    });

    const config = posix.join(home, '.config', 'BooksyReceiptBridge');
    mkdirSync(config, { recursive: true });
    writeFileSync(posix.join(config, 'config.json'), '{}');

    const result = await uninstall({ home, platform: 'linux', env: {}, log: () => undefined });

    expect(result.removed).toEqual(['Chrome']);
    expect(existsSync(posix.join(home, '.local/share/BooksyReceiptBridge'))).toBe(false);
    // The user's printer setup survives a reinstall. That is the point.
    expect(existsSync(posix.join(config, 'config.json'))).toBe(true);
  });
});

describe('the host name', () => {
  it('is the one the extension asks for', () => {
    // Two programs, one name. Read as text rather than imported: routing the
    // constant through @brb/shared would drag Zod into the extension bundle.
    const declared = readFileSync(
      new URL('../../../extension/src/messaging/host-name.ts', import.meta.url),
      'utf8',
    );
    expect(declared).toContain(`'${NATIVE_HOST_NAME}'`);
  });
});
