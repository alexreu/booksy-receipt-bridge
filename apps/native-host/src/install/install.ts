import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { installDir, installTargets, manifestContent, type InstallTarget } from './targets.ts';

/**
 * Install the service, from the service itself.
 *
 * The archive already carries an executable; requiring PowerShell on top of it
 * requires the one thing a locked-down till refuses - an execution policy that
 * allows scripts, and a file without the "came from the internet" mark. This
 * command does what Install.ps1 does, and needs no interpreter, no elevation
 * and no unblocking.
 */

const run = promisify(execFile);

/**
 * The name the browser knows the service by.
 *
 * Declared here rather than imported from the extension: the two are separate
 * programs, and routing the constant through @brb/shared would drag that
 * package's Zod dependency into the extension bundle. A test keeps them equal.
 */
export const NATIVE_HOST_NAME = 'com.alexdevlab.booksy_receipt_bridge';

export interface InstallDeps {
  /** The directory the delivered files sit in. Defaults to the executable's. */
  source?: string;
  extensionIds: readonly string[];
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the running program is. Injected so a test never copies a binary. */
  executable?: string;
  log: (message: string) => void;
}

export interface InstallResult {
  ok: boolean;
  installDir: string;
  executable: string;
  extensionPath?: string;
  registered: string[];
  error?: string;
}

const EXE_WINDOWS = 'booksy-receipt-bridge.exe';
const EXE_POSIX = 'booksy-receipt-bridge';

function environmentOf(deps: {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}) {
  return {
    platform: deps.platform ?? process.platform,
    home: deps.home ?? homedir(),
    configHome: (deps.env ?? process.env)['XDG_CONFIG_HOME'],
  };
}

/**
 * Are these two paths the same file on disk?
 *
 * Compared after resolving symlinks, not as strings. On macOS /tmp is a link to
 * /private/tmp, and `process.execPath` reports the resolved form: running the
 * INSTALLED copy therefore compared two spellings of one file, decided they
 * differed, and copying it onto itself threw. A test with equal paths could
 * never have caught that - running the binary did.
 */
function samePath(a: string, b: string): boolean {
  const settle = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      // Not created yet, which is the fresh-install case: the literal path is
      // then the best answer there is.
      return resolve(path);
    }
  };
  return settle(a) === settle(b);
}

/**
 * The delivered files, and which name the executable has there.
 *
 * Refused rather than guessed when pdfjs is missing: a service installed
 * without its font tables starts, answers PING, and fails on the first receipt
 * - the worst moment to find out.
 */
export function inspectSource(source: string): { exe: string } | { error: string } {
  const exe = [EXE_WINDOWS, EXE_POSIX]
    .map((name) => join(source, name))
    .find((path) => existsSync(path));
  if (exe === undefined) {
    return { error: `Aucun exécutable booksy-receipt-bridge dans ${source}.` };
  }
  if (!existsSync(join(source, 'pdfjs', 'standard_fonts'))) {
    return { error: `Le dossier pdfjs/standard_fonts est absent de ${source}.` };
  }
  return { exe };
}

export async function install(deps: InstallDeps): Promise<InstallResult> {
  const environment = environmentOf(deps);
  const env = deps.env ?? process.env;
  const executable = deps.executable ?? process.execPath;
  const source = resolve(deps.source ?? dirname(executable));
  const target = installDir(environment, env);
  const failure = (error: string): InstallResult => ({
    ok: false,
    installDir: target,
    executable: '',
    registered: [],
    error,
  });

  const found = inspectSource(source);
  if ('error' in found) return failure(found.error);

  if (deps.extensionIds.length === 0) {
    return failure("Aucun identifiant d'extension valide : le manifeste n'autoriserait personne.");
  }

  mkdirSync(target, { recursive: true });
  const exeTarget = join(target, environment.platform === 'win32' ? EXE_WINDOWS : EXE_POSIX);

  // Running the already-installed copy is the update case: copying a file onto
  // itself fails on Windows, and there would be nothing to copy anyway.
  if (!samePath(found.exe, exeTarget)) {
    try {
      cpSync(found.exe, exeTarget);
      rmSync(join(target, 'pdfjs'), { recursive: true, force: true });
      cpSync(join(source, 'pdfjs'), join(target, 'pdfjs'), { recursive: true });
    } catch (error) {
      return failure(
        `Copie impossible vers ${target} : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  deps.log(`  exécutable   ${exeTarget}`);

  // The extension gets a stable home: Chrome remembers the PATH of an unpacked
  // extension, and emptying Downloads would break the install.
  let extensionPath: string | undefined;
  const extensionSource = join(source, 'extension');
  if (existsSync(join(extensionSource, 'manifest.json'))) {
    extensionPath = join(target, 'extension');
    if (!samePath(extensionSource, extensionPath)) {
      rmSync(extensionPath, { recursive: true, force: true });
      cpSync(extensionSource, extensionPath, { recursive: true });
    }
    deps.log(`  extension    ${extensionPath}`);
  }

  const manifestPath = join(target, `${NATIVE_HOST_NAME}.json`);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifestContent(NATIVE_HOST_NAME, exeTarget, deps.extensionIds), null, 2)}\n`,
    'utf8',
  );
  deps.log(`  manifeste    ${manifestPath}`);

  const registered: string[] = [];
  for (const browser of installTargets(environment)) {
    if (await register(browser, manifestPath, environment.platform)) {
      registered.push(browser.browser);
      deps.log(`  enregistré   ${browser.browser}`);
    }
  }
  if (registered.length === 0) {
    deps.log('  ATTENTION    aucun navigateur Chromium trouvé dans ce profil.');
  }

  return {
    ok: true,
    installDir: target,
    executable: exeTarget,
    ...(extensionPath === undefined ? {} : { extensionPath }),
    registered,
  };
}

/**
 * Point one browser at the manifest.
 *
 * On Windows the key is written whether or not the browser is installed: the
 * user may install it later, and an orphan key is inert. Elsewhere the parent
 * directory has to exist already - creating one would invent a profile folder
 * for a browser that is not there.
 */
async function register(
  target: InstallTarget,
  manifestPath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (target.kind === 'registry') {
    if (platform !== 'win32') return false;
    // reg.exe, not PowerShell: this command exists precisely because
    // PowerShell could not be relied on.
    await run('reg', [
      'add',
      `${target.location}\\${NATIVE_HOST_NAME}`,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      manifestPath,
      '/f',
    ]);
    return true;
  }

  if (!existsSync(dirname(target.location))) return false;
  mkdirSync(target.location, { recursive: true });
  cpSync(manifestPath, join(target.location, `${NATIVE_HOST_NAME}.json`));
  return true;
}

export interface UninstallResult {
  removed: string[];
  installDir: string;
}

export async function uninstall(deps: {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
}): Promise<UninstallResult> {
  const environment = environmentOf(deps);
  const target = installDir(environment, deps.env ?? process.env);
  const removed: string[] = [];

  for (const browser of installTargets(environment)) {
    if (browser.kind === 'registry') {
      if (environment.platform !== 'win32') continue;
      await run('reg', ['delete', `${browser.location}\\${NATIVE_HOST_NAME}`, '/f']).then(
        () => {
          removed.push(browser.browser);
          deps.log(`  retiré       ${browser.browser}`);
        },
        // A key that was never there is not a failure worth reporting.
        () => undefined,
      );
      continue;
    }
    const manifest = join(browser.location, `${NATIVE_HOST_NAME}.json`);
    if (existsSync(manifest)) {
      rmSync(manifest);
      removed.push(browser.browser);
      deps.log(`  retiré       ${manifest}`);
    }
  }

  // The configuration and the logs live elsewhere and are deliberately kept:
  // they belong to the user, and a reinstall should find their printer again.
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    deps.log(`  fichiers     retirés de ${target}`);
  }

  return { removed, installDir: target };
}
