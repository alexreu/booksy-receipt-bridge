import { join } from 'node:path';

/**
 * Where a Chromium browser looks for a native messaging manifest.
 *
 * WHY THE SERVICE DOES THIS ITSELF. The PowerShell installer is blocked on a
 * locked-down machine - an execution policy set by the company, or the "came
 * from the internet" mark on a downloaded file - and a till is exactly the sort
 * of machine that has both. An executable is subject to neither, and it is
 * already in the archive.
 *
 * Windows keeps the pointer in the registry; everywhere else the manifest is a
 * file in the browser's own directory. Pure functions here, so the layout of a
 * platform can be asserted from a machine that is not running it.
 */

export type TargetKind = 'registry' | 'file';

export interface InstallTarget {
  browser: string;
  kind: TargetKind;
  /** A registry key under HKCU, or a NativeMessagingHosts directory. */
  location: string;
}

export interface TargetEnvironment {
  platform: NodeJS.Platform;
  home: string;
  /** Honoured on Linux, as the XDG spec requires. */
  configHome?: string | undefined;
}

export function installTargets(environment: TargetEnvironment): InstallTarget[] {
  const { platform, home } = environment;

  if (platform === 'win32') {
    // HKCU, never HKLM: no elevation, which a till user rarely has anyway.
    return [
      { browser: 'Chrome', key: 'Google\\Chrome' },
      { browser: 'Edge', key: 'Microsoft\\Edge' },
      { browser: 'Brave', key: 'BraveSoftware\\Brave-Browser' },
      { browser: 'Chromium', key: 'Chromium' },
    ].map(({ browser, key }) => ({
      browser,
      kind: 'registry' as const,
      location: `HKCU\\Software\\${key}\\NativeMessagingHosts`,
    }));
  }

  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return [
      { browser: 'Chrome', dir: join(support, 'Google', 'Chrome') },
      { browser: 'Chrome Beta', dir: join(support, 'Google', 'Chrome Beta') },
      { browser: 'Chrome Canary', dir: join(support, 'Google', 'Chrome Canary') },
      { browser: 'Chromium', dir: join(support, 'Chromium') },
      { browser: 'Edge', dir: join(support, 'Microsoft Edge') },
      { browser: 'Brave', dir: join(support, 'BraveSoftware', 'Brave-Browser') },
    ].map(({ browser, dir }) => ({
      browser,
      kind: 'file' as const,
      location: join(dir, 'NativeMessagingHosts'),
    }));
  }

  const configHome = environment.configHome ?? join(home, '.config');
  return [
    { browser: 'Chrome', dir: join(configHome, 'google-chrome') },
    { browser: 'Chromium', dir: join(configHome, 'chromium') },
    { browser: 'Edge', dir: join(configHome, 'microsoft-edge') },
    { browser: 'Brave', dir: join(configHome, 'BraveSoftware', 'Brave-Browser') },
  ].map(({ browser, dir }) => ({
    browser,
    kind: 'file' as const,
    location: join(dir, 'NativeMessagingHosts'),
  }));
}

/** Where the program goes. Never outside the user's profile. */
export function installDir(environment: TargetEnvironment, env: NodeJS.ProcessEnv = {}): string {
  if (environment.platform === 'win32') {
    const local = env['LOCALAPPDATA'] ?? join(environment.home, 'AppData', 'Local');
    return join(local, 'Programs', 'BooksyReceiptBridge');
  }
  return join(environment.home, '.local', 'share', 'BooksyReceiptBridge');
}

/**
 * The manifest a browser reads to know how to start the service.
 *
 * `allowed_origins` holds EXACT origins - Chrome refuses a wildcard, and this
 * list is the only thing between the service and any extension that cares to
 * call it.
 */
export function manifestContent(
  hostName: string,
  executable: string,
  extensionIds: readonly string[],
): Record<string, unknown> {
  return {
    name: hostName,
    description: 'Booksy Receipt Bridge',
    path: executable,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
}

/**
 * Split a comma-separated list, refusing what cannot be an extension id.
 *
 * An id is 32 letters from a to p - the encoding Chrome derives from the
 * public key. Refusing the rest is how a typo becomes an error message instead
 * of a manifest that authorises nobody and a popup that says the service is
 * missing.
 */
export function parseExtensionIds(value: string): string[] {
  return value
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => /^[a-p]{32}$/.test(id));
}
