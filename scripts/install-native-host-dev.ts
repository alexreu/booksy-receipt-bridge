/**
 * Register the native host for local development.
 *
 * Without this the popup has nothing to talk to: a browser only launches a
 * native host it can find a manifest for, and the manifest must name this
 * extension's exact id - wildcards are forbidden (plan section 11).
 *
 *   pnpm host:install                  register for every browser found
 *   pnpm host:install --id XXXX        add another extension id (Chrome vs Edge, section 52)
 *   pnpm host:install --profile <dir>  also register inside a custom --user-data-dir
 *   pnpm host:install --uninstall
 *
 * This is the DEVELOPMENT path. It points the browser at a shell wrapper that
 * runs the TypeScript source through tsx, so edits take effect on the next
 * launch. The real installer, with a bundled executable and Windows registry
 * entries, is phase 9.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { NATIVE_HOST_NAME } from '../apps/extension/src/messaging/host-name.ts';

const REPO = resolve(import.meta.dirname, '..');
const WRAPPER_DIR = join(REPO, 'debug', 'native-host-dev');
const WRAPPER = join(WRAPPER_DIR, 'booksy-receipt-bridge');

const argv = process.argv.slice(2);
const uninstall = argv.includes('--uninstall');
const extraIds = argv.flatMap((argument, index) =>
  argument === '--id' ? [argv[index + 1] ?? ''] : [],
).filter((id) => id !== '');

/**
 * Extra `NativeMessagingHosts` directories to write into.
 *
 * A browser started with `--user-data-dir` looks the manifest up under THAT
 * directory, not under the standard per-user location. Found the hard way while
 * testing the extension in a throwaway profile: the popup reported the host as
 * not installed even though the standard manifest was in place.
 */
const profileDirs = argv.flatMap((argument, index) =>
  argument === '--profile' ? [argv[index + 1] ?? ''] : [],
).filter((dir) => dir !== '');

/** Directories a Chromium browser reads native messaging manifests from. */
function manifestDirs(): { browser: string; dir: string }[] {
  const home = homedir();

  if (process.platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return [
      { browser: 'Chrome', dir: join(support, 'Google', 'Chrome') },
      { browser: 'Chrome Beta', dir: join(support, 'Google', 'Chrome Beta') },
      { browser: 'Chrome Canary', dir: join(support, 'Google', 'Chrome Canary') },
      { browser: 'Edge', dir: join(support, 'Microsoft Edge') },
      { browser: 'Brave', dir: join(support, 'BraveSoftware', 'Brave-Browser') },
      { browser: 'Chromium', dir: join(support, 'Chromium') },
    ].map((entry) => ({ ...entry, dir: join(entry.dir, 'NativeMessagingHosts') }));
  }

  if (process.platform === 'linux') {
    const config = join(home, '.config');
    return [
      { browser: 'Chrome', dir: join(config, 'google-chrome') },
      { browser: 'Edge', dir: join(config, 'microsoft-edge') },
      { browser: 'Brave', dir: join(config, 'BraveSoftware', 'Brave-Browser') },
      { browser: 'Chromium', dir: join(config, 'chromium') },
    ].map((entry) => ({ ...entry, dir: join(entry.dir, 'NativeMessagingHosts') }));
  }

  return [];
}

function extensionIds(): string[] {
  const pinned = join(REPO, 'apps', 'extension', '.extension-id');
  const ids = [...extraIds];
  if (existsSync(pinned)) {
    const id = readFileSync(pinned, 'utf8').trim();
    if (id !== '') ids.unshift(id);
  }
  return [...new Set(ids)];
}

function writeWrapper(): void {
  // Absolute paths throughout, and the node binary by full path rather than
  // through PATH.
  //
  // A native host is spawned with no shell, an unpredictable working directory
  // and a sanitised environment. `node_modules/.bin/tsx` is a shell script that
  // execs `node`, so with node installed by nvm or fnm - the common case on
  // macOS - it dies with "node: not found" before the host ever starts. That
  // failure was reproduced by running this wrapper under `env -i`.
  const nodeBinary = process.execPath;
  const tsxCli = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = join(REPO, 'apps', 'native-host', 'src', 'main.ts');

  if (!existsSync(tsxCli)) {
    throw new Error(`tsx introuvable à ${tsxCli}. Lancez pnpm install.`);
  }

  mkdirSync(WRAPPER_DIR, { recursive: true });
  writeFileSync(
    WRAPPER,
    [
      '#!/bin/sh',
      '# Généré par pnpm host:install. Ne pas éditer.',
      `PATH="${dirname(nodeBinary)}:$PATH"`,
      'export PATH',
      `exec "${nodeBinary}" "${tsxCli}" "${entry}" "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(WRAPPER, 0o755);
}

function main(): number {
  const dirs = manifestDirs();

  if (process.platform === 'win32') {
    process.stderr.write(
      'Windows : cette commande de développement ne gère pas le registre.\n' +
        'Écrivez le manifest puis enregistrez-le sous\n' +
        '  HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' +
        `${NATIVE_HOST_NAME}\n` +
        "L'installeur de la phase 9 s'en chargera.\n",
    );
    return 1;
  }

  const targets = [
    ...dirs.filter((entry) => existsSync(join(entry.dir, '..'))),
    ...profileDirs.map((dir) => ({
      browser: `profil ${dir}`,
      dir: join(dir, 'NativeMessagingHosts'),
    })),
  ];
  if (targets.length === 0) {
    process.stderr.write('Aucun navigateur Chromium détecté.\n');
    return 1;
  }

  if (uninstall) {
    for (const { browser, dir } of targets) {
      const path = join(dir, `${NATIVE_HOST_NAME}.json`);
      if (existsSync(path)) {
        rmSync(path);
        process.stderr.write(`retiré  ${browser}: ${path}\n`);
      }
    }
    rmSync(WRAPPER_DIR, { recursive: true, force: true });
    return 0;
  }

  const ids = extensionIds();
  if (ids.length === 0) {
    process.stderr.write(
      'Aucun identifiant d’extension. Lancez `pnpm gen:extension-key` ou passez --id.\n',
    );
    return 1;
  }

  writeWrapper();

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Booksy Receipt Bridge',
    path: WRAPPER,
    type: 'stdio',
    // Exact origins only. A wildcard here would let any extension drive the
    // host (plan section 11).
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };

  for (const { browser, dir } of targets) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stderr.write(`installé ${browser}: ${path}\n`);
  }

  process.stderr.write(`\nhost      ${WRAPPER}\norigines  ${manifest.allowed_origins.join(', ')}\n`);
  process.stderr.write(
    '\nRechargez l’extension, puis ouvrez le popup. ' +
      'Si le navigateur était ouvert, redémarrez-le.\n',
  );
  return 0;
}

process.exitCode = main();
