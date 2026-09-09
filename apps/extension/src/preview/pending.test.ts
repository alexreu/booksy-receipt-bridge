import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, type ReceiptSource } from '@brb/shared';
import type { SessionStorage } from '../storage.ts';
import {
  MAX_PENDING,
  PENDING_KEY,
  addPending,
  dropPending,
  findPending,
  previewId,
  readPending,
  type PendingPreview,
} from './pending.ts';

interface Memory extends SessionStorage {
  snapshot(): Record<string, unknown>;
}

function memoryStorage(initial: Record<string, unknown> = {}): Memory {
  const data: Record<string, unknown> = { ...initial };
  return {
    get: (key) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
    snapshot: () => data,
  };
}

const PATH_SOURCE: ReceiptSource = { kind: 'path', path: '/Users/x/Downloads/recu-1167.pdf' };

function pending(overrides: Partial<PendingPreview> = {}): PendingPreview {
  return { id: 'p-1', source: PATH_SOURCE, createdAt: 1_000, ...overrides };
}

let storage: Memory;

beforeEach(() => {
  storage = memoryStorage();
});

describe('addPending and findPending', () => {
  it('stores a preview and finds it by id', async () => {
    await addPending(storage, pending());
    expect(await findPending(storage, 'p-1')).toEqual(pending());
  });

  it('finds nothing for an unknown id', async () => {
    await addPending(storage, pending());
    expect(await findPending(storage, 'p-999')).toBeUndefined();
  });

  it('replaces rather than duplicates the same id', async () => {
    await addPending(storage, pending());
    await addPending(storage, pending({ label: 'recu.pdf' }));
    const all = await readPending(storage);
    expect(all).toHaveLength(1);
    expect(all[0]?.label).toBe('recu.pdf');
  });

  it('caps the queue, since it holds one decision and not a spool', async () => {
    for (let index = 0; index < MAX_PENDING + 3; index++) {
      await addPending(storage, pending({ id: `p-${index}` }));
    }
    expect(await readPending(storage)).toHaveLength(MAX_PENDING);
  });

  it('survives the worker being evicted between the two calls', async () => {
    // The approval page opens in a tab, and the worker is very likely gone by
    // the time it asks for the render.
    await addPending(storage, pending());
    const reread = memoryStorage(storage.snapshot());
    expect(await findPending(reread, 'p-1')).toEqual(pending());
  });

  it('keeps a bytes source as well as a path one', async () => {
    const bytes: ReceiptSource = { kind: 'bytes', base64: 'JVBERi0=' };
    await addPending(storage, pending({ id: 'p-2', source: bytes }));
    expect((await findPending(storage, 'p-2'))?.source).toEqual(bytes);
  });
});

describe('readPending', () => {
  it('starts empty', async () => {
    expect(await readPending(storage)).toEqual([]);
  });

  it('ignores entries whose shape it does not recognise', async () => {
    const dirty = memoryStorage({
      [PENDING_KEY]: [
        pending(),
        null,
        'nope',
        { id: 'x' },
        { id: 'y', createdAt: 1, source: { kind: 'url', url: 'https://evil' } },
      ],
    });
    const all = await readPending(dirty);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('p-1');
  });

  it('ignores a stored value that is not a list', async () => {
    expect(await readPending(memoryStorage({ [PENDING_KEY]: { a: 1 } }))).toEqual([]);
  });
});

describe('dropPending', () => {
  it('removes only the named preview', async () => {
    await addPending(storage, pending({ id: 'p-1' }));
    await addPending(storage, pending({ id: 'p-2' }));
    expect((await dropPending(storage, 'p-1')).map((entry) => entry.id)).toEqual(['p-2']);
  });
});

describe('previewId', () => {
  it('depends only on the clock and on what is already queued', async () => {
    const clock = fixedClock(1_700_000_000_000);
    expect(previewId(clock, [])).toBe(previewId(clock, []));
    expect(previewId(clock, [])).not.toBe(previewId(clock, [pending()]));
  });

  it('is safe to put in a URL', () => {
    expect(previewId(fixedClock(1_700_000_000_000), [])).toMatch(/^p-[0-9a-z]+-[0-9a-z]+$/);
  });
});
