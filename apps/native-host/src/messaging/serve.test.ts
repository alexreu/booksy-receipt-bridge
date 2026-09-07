import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { NativeResponse } from '@brb/shared';
import { silentLogger } from '../logging/logger.ts';
import { FrameReader, HEADER_BYTES, MAX_INCOMING_BYTES, encodeFrame } from './framing.ts';
import { serve } from './serve.ts';

interface Run {
  responses: unknown[];
  received: unknown[];
  stdout: Buffer;
}

/**
 * Drive the loop over a pair of in-memory pipes.
 *
 * `write` gets the input stream so a test can control chunk boundaries, which
 * is where a framing bug actually shows up.
 */
async function run(
  write: (input: PassThrough) => void,
  handle?: (raw: unknown) => Promise<NativeResponse>,
  log = silentLogger(),
): Promise<Run> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));

  const received: unknown[] = [];
  const defaultHandle = async (raw: unknown): Promise<NativeResponse> => {
    received.push(raw);
    const id = (raw as { id?: string }).id ?? 'unknown';
    return { id, success: true, data: { seen: received.length } };
  };

  const finished = serve({ input, output, log, handle: handle ?? defaultHandle });
  write(input);
  input.end();
  await finished;

  const stdout = Buffer.concat(chunks);
  const reader = new FrameReader();
  const responses = reader.push(stdout).map((frame) => (frame.ok ? frame.value : frame));
  return { responses, received, stdout };
}

describe('serve', () => {
  it('answers one message', async () => {
    const { responses } = await run((input) => {
      input.write(encodeFrame({ id: 'a', type: 'PING' }));
    });
    expect(responses).toEqual([{ id: 'a', success: true, data: { seen: 1 } }]);
  });

  it('answers several messages delivered in one write', async () => {
    const { responses } = await run((input) => {
      input.write(
        Buffer.concat([
          encodeFrame({ id: 'a', type: 'PING' }),
          encodeFrame({ id: 'b', type: 'PING' }),
          encodeFrame({ id: 'c', type: 'PING' }),
        ]),
      );
    });
    expect(responses.map((response) => (response as NativeResponse).id)).toEqual(['a', 'b', 'c']);
  });

  it('reassembles a message split across writes', async () => {
    const frame = encodeFrame({ id: 'split', type: 'GET_STATUS' });
    const { responses } = await run((input) => {
      input.write(frame.subarray(0, 7));
      input.write(frame.subarray(7));
    });
    expect(responses).toEqual([{ id: 'split', success: true, data: { seen: 1 } }]);
  });

  it('answers in order even when a handler is slow', async () => {
    // Responses carry their id so Chrome does not need ordering, but keeping it
    // stops config reads and writes from interleaving.
    const handle = async (raw: unknown): Promise<NativeResponse> => {
      const id = (raw as { id: string }).id;
      if (id === 'slow') await new Promise((resolve) => setTimeout(resolve, 20));
      return { id, success: true };
    };
    const { responses } = await run((input) => {
      input.write(encodeFrame({ id: 'slow', type: 'PING' }));
      input.write(encodeFrame({ id: 'fast', type: 'PING' }));
    }, handle);
    expect(responses.map((response) => (response as NativeResponse).id)).toEqual(['slow', 'fast']);
  });

  it('writes nothing but frames, so stdout stays parseable', async () => {
    const { stdout } = await run((input) => {
      input.write(encodeFrame({ id: 'a', type: 'PING' }));
    });
    // The whole stream must decode with no leftover bytes.
    const reader = new FrameReader();
    expect(reader.push(stdout)).toHaveLength(1);
    expect(reader.pending).toBe(0);
  });

  it('skips a frame with an invalid body and keeps serving the next', async () => {
    const log = silentLogger();
    const error = vi.spyOn(log, 'error');

    const bad = Buffer.alloc(HEADER_BYTES + 3);
    bad.writeUInt32LE(3, 0);
    bad.write('{[}', HEADER_BYTES, 'utf8');

    const { responses } = await run(
      (input) => {
        input.write(bad);
        input.write(encodeFrame({ id: 'after', type: 'PING' }));
      },
      undefined,
      log,
    );
    expect(error).toHaveBeenCalled();
    expect(responses).toEqual([{ id: 'after', success: true, data: { seen: 1 } }]);
  });

  it('stops on an oversized declared length instead of misreading the stream', async () => {
    const log = silentLogger();
    const error = vi.spyOn(log, 'error');

    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(MAX_INCOMING_BYTES + 1, 0);

    const { responses, received } = await run(
      (input) => {
        input.write(header);
        input.write(encodeFrame({ id: 'ignored', type: 'PING' }));
      },
      undefined,
      log,
    );
    expect(error).toHaveBeenCalled();
    expect(received).toEqual([]);
    expect(responses).toEqual([]);
  });

  it('warns when the stream ends mid-frame', async () => {
    const log = silentLogger();
    const warn = vi.spyOn(log, 'warn');
    const frame = encodeFrame({ id: 'truncated', type: 'PING' });

    const { responses } = await run(
      (input) => {
        input.write(frame.subarray(0, frame.length - 2));
      },
      undefined,
      log,
    );
    expect(responses).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplète'));
  });

  it('returns cleanly on an empty stream', async () => {
    const { responses } = await run(() => undefined);
    expect(responses).toEqual([]);
  });

  it('logs the connection opening and closing', async () => {
    const log = silentLogger();
    const info = vi.spyOn(log, 'info');
    await run(() => undefined, undefined, log);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('ouverte'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('fermée'));
  });

  it('treats EPIPE as a normal shutdown - the browser went away', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();

    const finished = serve({
      input,
      output,
      log: silentLogger(),
      handle: async (raw) => ({ id: (raw as { id: string }).id, success: true }),
    });

    const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    input.emit('error', epipe);
    await expect(finished).resolves.toBeUndefined();
  });
});
