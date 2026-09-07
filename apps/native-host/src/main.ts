/**
 * Native messaging host entry point.
 *
 * With no arguments it speaks the Native Messaging protocol on stdin/stdout,
 * which is how Chrome launches it. With arguments it is a plain CLI - see
 * cli.ts. That duality is deliberate (plan section 58): the host must be able
 * to read, render and print a Booksy PDF with no browser involved, because the
 * extension is only a UX layer over it.
 *
 *   STDOUT BELONGS TO THE PROTOCOL.
 *
 * In messaging mode nothing may reach stdout but encoded frames. Diagnostics go
 * to stderr or to the log file; ESLint enforces no-console in this directory.
 */
import { createHost } from './host.ts';
import { createLogger } from './logging/logger.ts';
import { serve } from './messaging/serve.ts';
import { logDir } from './paths.ts';

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length > 0) {
    const { runCli } = await import('./cli.ts');
    return runCli(argv);
  }

  const log = createLogger({ dir: logDir() });
  const host = createHost({ log });

  try {
    await serve({
      input: process.stdin,
      output: process.stdout,
      log,
      handle: host.handle,
    });
    return 0;
  } catch (error) {
    log.error(`Arrêt sur erreur : ${error instanceof Error ? error.stack : String(error)}`);
    return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
