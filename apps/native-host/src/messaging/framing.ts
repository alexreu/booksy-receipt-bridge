/**
 * Native Messaging wire format (plan section 13).
 *
 * Each message is a 32-bit length in the platform's native byte order followed
 * by that many bytes of UTF-8 JSON. Little-endian covers x64 and ARM64, which is
 * every machine this host targets.
 *
 * The reader is a pure accumulator with no I/O, because the interesting cases
 * are all about chunk boundaries: a length split across two reads, several
 * messages in one read, a body that arrives in pieces. Those are unpleasant to
 * reproduce against a real pipe and trivial against a function.
 */

export const HEADER_BYTES = 4;

/**
 * Refuse a declared length beyond this. Chrome itself allows very large
 * extension-to-host messages, but a hostile or broken writer must not be able
 * to make the host allocate without bound.
 */
export const MAX_INCOMING_BYTES = 32 * 1024 * 1024;

export type Frame =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; fatal?: boolean };

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export interface FrameReader {
  /** Feed bytes; get back every complete frame they completed. */
  push(chunk: Buffer): Frame[];
  /** Bytes held back waiting for the rest of a frame. */
  readonly pending: number;
}

/**
 * A closure over the partial buffer.
 *
 * Stateful by nature - it exists to remember the bytes that did not yet make a
 * whole frame - but referentially transparent in the sense that matters: the
 * same sequence of pushes always yields the same sequence of frames, and
 * nothing outside it is observed or touched. The local mutation is a bounded
 * accumulator on the read path, and removing it would mean copying the buffer
 * on every chunk for no gain.
 */
export function createFrameReader(): FrameReader {
  let buffer: Buffer = Buffer.alloc(0);
  let stopped = false;

  const push = (chunk: Buffer): Frame[] => {
    if (stopped) return [];
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    const frames: Frame[] = [];
    for (;;) {
      if (buffer.length < HEADER_BYTES) break;

      const length = buffer.readUInt32LE(0);
      if (length > MAX_INCOMING_BYTES) {
        // Unrecoverable: the stream position is no longer trustworthy, so stop
        // rather than resynchronise on what might be message bodies.
        stopped = true;
        frames.push({
          ok: false,
          reason: `Message de ${length} octets, au-delà de la limite de ${MAX_INCOMING_BYTES}.`,
          fatal: true,
        });
        break;
      }
      if (buffer.length < HEADER_BYTES + length) break;

      const body = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      buffer = buffer.subarray(HEADER_BYTES + length);

      try {
        frames.push({ ok: true, value: JSON.parse(body.toString('utf8')) });
      } catch {
        // The framing held, only the payload was bad: the next frame is still
        // readable, so report and carry on.
        frames.push({ ok: false, reason: 'Corps de message JSON invalide.' });
      }
    }
    return frames;
  };

  return {
    push,
    get pending() {
      return buffer.length;
    },
  };
}
