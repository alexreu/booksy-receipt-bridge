/**
 * Build the native host into a single executable (plan section 50, AC20).
 *
 *   pnpm build:host              for this machine, to smoke-test the bundle
 *   pnpm build:host --win        booksy-receipt-bridge.exe for Windows x64
 *
 * WHY A SINGLE EXECUTABLE. AC20 says the client does not install Node.js, so
 * the runtime has to travel with the host. Node's own SEA does that: bundle to
 * one CommonJS file, turn it into a blob, and inject the blob into a copy of
 * the `node` binary.
 *
 * WHY IT CAN BE CROSS-BUILT. Injection only appends a section to the target
 * binary, so a Windows executable can be produced from macOS by downloading the
 * matching `node.exe` first. What cannot be done from here is SIGNING it, and
 * an unsigned executable makes SmartScreen warn the user - hence the CI job on
 * windows-latest.
 */
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require_ = createRequire(import.meta.url);

const REPO = resolve(import.meta.dirname, '..');
const OUT = join(REPO, 'installer', 'build');
const ENTRY = join(REPO, 'apps', 'native-host', 'src', 'main.ts');

const forWindows = process.argv.includes('--win');
const NODE_VERSION = process.versions.node;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** pdf.js reads these at runtime and they cannot live inside the blob. */
const PDFJS_ASSETS = ['standard_fonts', 'cmaps', 'wasm'];

async function bundle(): Promise<string> {
  const { build } = await import('esbuild');
  const outfile = join(OUT, 'host.cjs');

  await build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    // CommonJS because Node's SEA entry point must be CJS, even though the
    // source is ESM throughout.
    format: 'cjs',
    target: 'node22',
    // A CommonJS bundle has no `import.meta.url`. createRequire accepts an
    // absolute path as well as a file URL, and __filename is one - without this
    // the executable died at module initialisation.
    define: { 'import.meta.url': '__filename', 'import.meta.dirname': '__dirname' },
    // Keeps the stack traces in the log file readable.
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
  });

  log(`bundle -> ${outfile}`);
  return outfile;
}

async function copyAssets(): Promise<void> {
  const root = dirname(require_.resolve('pdfjs-dist/package.json'));
  for (const asset of PDFJS_ASSETS) {
    await cp(join(root, asset), join(OUT, 'pdfjs', asset), { recursive: true });
  }
  // Flat, next to the fonts: pdf.js loads this module to stand in for a real
  // worker, and the host points workerSrc straight at it.
  await cp(
    join(root, 'legacy', 'build', 'pdf.worker.mjs'),
    join(OUT, 'pdfjs', 'pdf.worker.mjs'),
  );
  log(`assets pdf.js -> ${join(OUT, 'pdfjs')}`);
}

async function makeBlob(main: string): Promise<string> {
  const configPath = join(OUT, 'sea-config.json');
  const blob = join(OUT, 'host.blob');
  await writeFile(
    configPath,
    `${JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true }, null, 2)}\n`,
    'utf8',
  );
  await run(process.execPath, ['--experimental-sea-config', configPath]);
  log(`blob -> ${blob}`);
  return blob;
}

/**
 * The binary the blob is injected into.
 *
 * For a Windows build this is a downloaded `node.exe` of the same version as
 * the one building it, so the bundle and the runtime cannot disagree.
 */
async function baseBinary(): Promise<{ path: string; name: string }> {
  if (!forWindows) {
    const copyPath = join(OUT, 'booksy-receipt-bridge');
    await cp(process.execPath, copyPath);
    await chmod(copyPath, 0o755);
    return { path: copyPath, name: 'booksy-receipt-bridge' };
  }

  const url = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;
  const target = join(OUT, 'booksy-receipt-bridge.exe');
  log(`téléchargement de ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`node.exe v${NODE_VERSION} indisponible (${response.status})`);
  }
  await writeFile(target, new Uint8Array(await response.arrayBuffer()));
  return { path: target, name: 'booksy-receipt-bridge.exe' };
}

async function inject(binary: string, blob: string): Promise<void> {
  const postject = require_.resolve('postject/dist/cli.js');
  const args = [
    postject,
    binary,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  // Mach-O needs the segment name; PE does not take it.
  if (!forWindows && process.platform === 'darwin') {
    args.push('--macho-segment-name', 'NODE_SEA');
  }
  await run(process.execPath, args);
  log(`injection -> ${binary}`);

  // macOS refuses to run a binary whose signature no longer matches its
  // contents, and injection changes the contents: the unsigned result was
  // killed with SIGKILL and printed nothing at all. An ad-hoc signature is
  // enough for a local smoke test.
  if (!forWindows && process.platform === 'darwin') {
    await run('codesign', ['--remove-signature', binary]).catch(() => undefined);
    await run('codesign', ['--sign', '-', binary]);
    log('re-signature ad-hoc (macOS refuse un binaire modifié)');
  }
}

async function main(): Promise<number> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const main_ = await bundle();
  await copyAssets();
  const blob = await makeBlob(main_);
  const { path, name } = await baseBinary();
  await inject(path, blob);

  // The bundle and the blob are build intermediates; shipping them would only
  // confuse whoever opens the folder.
  await rm(main_, { force: true });
  await rm(blob, { force: true });
  await rm(join(OUT, 'sea-config.json'), { force: true });

  const size = (await readFile(path)).length;
  log(`\n${name} : ${(size / 1024 / 1024).toFixed(1)} Mo`);
  log(`dossier : ${OUT}`);
  if (forWindows) {
    log('\nNON SIGNÉ : SmartScreen avertira le client. La signature exige Windows.');
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log(`${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
