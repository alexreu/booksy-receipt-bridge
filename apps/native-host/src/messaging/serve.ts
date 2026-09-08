import type { Readable, Writable } from 'node:stream';
import type { NativeResponse } from '@brb/shared';
import type { Logger } from '../logging/logger.ts';
import { createFrameReader, encodeFrame } from './framing.ts';

export interface ServeOptions {
  input: Readable;
  output: Writable;
  log: Logger;
  handle: (raw: unknown) => Promise<NativeResponse>;
}

/**
 * Run the stdin/stdout message loop until the input closes.
 *
 * Messages are handled one at a time and in order. Chrome does not require
 * ordering - every response carries the id it answers - but serialising keeps
 * config reads and writes from interleaving, and the host has no throughput
 * problem worth trading that for.
 *
 * Resolves when the input ends, which is how Chrome shuts a host down.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const { input, output, log, handle } = options;
  const reader = createFrameReader();

  log.info('Connexion Native Messaging ouverte');

  let queue: Promise<void> = Promise.resolve();
  let fatal = false;

  await new Promise<void>((resolve, reject) => {
    input.on('data', (chunk: Buffer) => {
      if (fatal) return;
      for (const frame of reader.push(chunk)) {
        if (!frame.ok) {
          log.error(`Trame rejetée : ${frame.reason}`);
          if (frame.fatal === true) {
            fatal = true;
            input.destroy();
            return;
          }
          continue;
        }
        const value = frame.value;
        queue = queue.then(async () => {
          const response = await handle(value);
          output.write(encodeFrame(response));
        });
      }
    });

    input.on('end', resolve);
    input.on('close', resolve);
    input.on('error', (error: Error) => {
      // EPIPE means the browser went away, which is a normal shutdown.
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') resolve();
      else reject(error);
    });
  });

  await queue;
  if (reader.pending > 0) {
    log.warn(`Flux terminé sur une trame incomplète (${reader.pending} octets).`);
  }
  log.info('Connexion Native Messaging fermée');
}
