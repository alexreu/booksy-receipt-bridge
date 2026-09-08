import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_DETECTED,
  STORAGE_KEY,
  forgetDetected,
  pendingCount,
  readDetected,
  rememberDetected,
  type DetectedReceipt,
  type SessionStorage,
} from './store.ts';

interface MemoryStorage extends SessionStorage {
  snapshot(): Record<string, unknown>;
}

function memoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
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

function receipt(overrides: Partial<DetectedReceipt> = {}): DetectedReceipt {
  return {
    downloadId: 1,
    path: '/Users/x/Downloads/recu-1167.pdf',
    ticketNumber: '1167',
    totalTTC: 300,
    confidence: 1,
    warningCount: 0,
    detectedAt: 1_000,
    reason: 'booksy',
    ...overrides,
  };
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = memoryStorage();
});

describe('readDetected', () => {
  it('starts empty', async () => {
    expect(await readDetected(storage)).toEqual([]);
  });

  it('ignores anything in storage that is not a receipt', async () => {
    // Session storage is shared with anything else the extension puts there,
    // and a stale shape from an older version must not crash the popup.
    const dirty = memoryStorage({
      [STORAGE_KEY]: [receipt(), null, 'nope', {}, { downloadId: 'deux' }],
    });
    expect(await readDetected(dirty)).toHaveLength(1);
  });

  it('ignores a stored value that is not a list', async () => {
    expect(await readDetected(memoryStorage({ [STORAGE_KEY]: { a: 1 } }))).toEqual([]);
  });
});

describe('rememberDetected', () => {
  it('keeps the newest first', async () => {
    await rememberDetected(storage, receipt({ downloadId: 1, ticketNumber: '1' }));
    const all = await rememberDetected(storage, receipt({ downloadId: 2, ticketNumber: '2' }));
    expect(all.map((entry) => entry.ticketNumber)).toEqual(['2', '1']);
  });

  it('replaces rather than duplicates the same download', async () => {
    // A single download fires several change events.
    await rememberDetected(storage, receipt({ downloadId: 7, ticketNumber: '7' }));
    const all = await rememberDetected(storage, receipt({ downloadId: 7, ticketNumber: '7bis' }));
    expect(all).toHaveLength(1);
    expect(all[0]?.ticketNumber).toBe('7bis');
  });

  it('caps the list, since it holds pending work and never a log', async () => {
    for (let id = 0; id <= MAX_DETECTED + 3; id++) {
      await rememberDetected(storage, receipt({ downloadId: id }));
    }
    expect(await readDetected(storage)).toHaveLength(MAX_DETECTED);
  });

  it('survives the worker being evicted between writes', async () => {
    // Nothing is held in a variable: an MV3 worker is shut down within seconds
    // of the download event, long before the popup is opened.
    await rememberDetected(storage, receipt({ downloadId: 5 }));
    const reread = await readDetected(memoryStorage(storage.snapshot()));
    expect(reread.map((entry) => entry.downloadId)).toEqual([5]);
  });
});

describe('forgetDetected', () => {
  it('removes only the named entry', async () => {
    await rememberDetected(storage, receipt({ downloadId: 1 }));
    await rememberDetected(storage, receipt({ downloadId: 2 }));
    expect((await forgetDetected(storage, 1)).map((entry) => entry.downloadId)).toEqual([2]);
  });
});

describe('pendingCount', () => {
  it('is the list length, since a printed receipt leaves the list', () => {
    expect(pendingCount([receipt({ downloadId: 1 }), receipt({ downloadId: 2 })])).toBe(2);
    expect(pendingCount([])).toBe(0);
  });
});
