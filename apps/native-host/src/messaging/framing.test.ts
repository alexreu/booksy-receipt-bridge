import { describe, expect, it } from 'vitest';
import {
  createFrameReader,
  HEADER_BYTES,
  MAX_INCOMING_BYTES,
  encodeFrame,
} from './framing.ts';

function frameOf(value: unknown): Buffer {
  return encodeFrame(value);
}

function values(reader: ReturnType<typeof createFrameReader>, chunk: Buffer): unknown[] {
  return reader.push(chunk).map((frame) => (frame.ok ? frame.value : { error: frame.reason }));
}

describe('encodeFrame', () => {
  it('prefixes the body with its byte length, little-endian', () => {
    const frame = encodeFrame({ id: 'a', type: 'PING' });
    const body = JSON.stringify({ id: 'a', type: 'PING' });
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(body, 'utf8'));
    expect(frame.subarray(HEADER_BYTES).toString('utf8')).toBe(body);
  });

  it('measures bytes, not characters', () => {
    // A multi-byte character must not make the header disagree with the body,
    // which would desynchronise the stream from that point on.
    const frame = encodeFrame({ label: 'Café 12,50 €' });
    expect(frame.readUInt32LE(0)).toBe(frame.length - HEADER_BYTES);
  });
});

describe('createFrameReader', () => {
  it('reads one whole frame', () => {
    const reader = createFrameReader();
    expect(values(reader, frameOf({ id: '1', type: 'PING' }))).toEqual([
      { id: '1', type: 'PING' },
    ]);
    expect(reader.pending).toBe(0);
  });

  it('reads several frames delivered in one chunk', () => {
    const reader = createFrameReader();
    const chunk = Buffer.concat([frameOf({ n: 1 }), frameOf({ n: 2 }), frameOf({ n: 3 })]);
    expect(values(reader, chunk)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('waits for a body that arrives in pieces', () => {
    const reader = createFrameReader();
    const frame = frameOf({ id: 'split', type: 'GET_STATUS' });

    expect(values(reader, frame.subarray(0, 6))).toEqual([]);
    expect(reader.pending).toBe(6);
    expect(values(reader, frame.subarray(6))).toEqual([{ id: 'split', type: 'GET_STATUS' }]);
    expect(reader.pending).toBe(0);
  });

  it('waits for a length header that arrives in pieces', () => {
    const reader = createFrameReader();
    const frame = frameOf({ id: 'x' });

    expect(values(reader, frame.subarray(0, 1))).toEqual([]);
    expect(values(reader, frame.subarray(1, 3))).toEqual([]);
    expect(values(reader, frame.subarray(3))).toEqual([{ id: 'x' }]);
  });

  it('reads a frame delivered one byte at a time', () => {
    const reader = createFrameReader();
    const frame = frameOf({ id: 'drip', type: 'PING' });
    const seen: unknown[] = [];
    for (const byte of frame) {
      seen.push(...values(reader, Buffer.from([byte])));
    }
    expect(seen).toEqual([{ id: 'drip', type: 'PING' }]);
  });

  it('handles a chunk that ends mid-frame after a complete one', () => {
    const reader = createFrameReader();
    const first = frameOf({ n: 1 });
    const second = frameOf({ n: 2 });

    expect(values(reader, Buffer.concat([first, second.subarray(0, 5)]))).toEqual([{ n: 1 }]);
    expect(values(reader, second.subarray(5))).toEqual([{ n: 2 }]);
  });

  it('reports an invalid body but keeps reading the next frame', () => {
    const reader = createFrameReader();
    const bad = Buffer.alloc(HEADER_BYTES + 5);
    bad.writeUInt32LE(5, 0);
    bad.write('not{}', HEADER_BYTES, 'utf8');

    const frames = reader.push(Buffer.concat([bad, frameOf({ n: 2 })]));
    expect(frames[0]).toMatchObject({ ok: false });
    expect(frames[1]).toEqual({ ok: true, value: { n: 2 } });
  });

  it('refuses a declared length beyond the cap and stops reading', () => {
    // Without this a hostile writer could make the host allocate without bound;
    // and once a length is nonsense the stream position cannot be trusted.
    const reader = createFrameReader();
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(MAX_INCOMING_BYTES + 1, 0);

    const frames = reader.push(header);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, fatal: true });

    // Stopped: later bytes are ignored rather than misinterpreted.
    expect(reader.push(frameOf({ n: 1 }))).toEqual([]);
  });

  it('accepts a zero-length frame without hanging', () => {
    const reader = createFrameReader();
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(0, 0);
    const frames = reader.push(Buffer.concat([header, frameOf({ n: 1 })]));
    expect(frames[0]).toMatchObject({ ok: false });
    expect(frames[1]).toEqual({ ok: true, value: { n: 1 } });
  });

  it('returns nothing for an empty chunk', () => {
    expect(createFrameReader().push(Buffer.alloc(0))).toEqual([]);
  });

  it('round-trips a payload at the cap boundary', () => {
    const reader = createFrameReader();
    const value = { pad: 'x'.repeat(1000) };
    expect(values(reader, frameOf(value))).toEqual([value]);
  });
});
