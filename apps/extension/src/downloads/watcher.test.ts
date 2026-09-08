import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, type ParseResult, type Receipt } from '@brb/shared';
import { createMockNativeHostClient } from '../messaging/mock-client.ts';
import type { DownloadCandidate } from './filter.ts';
import { readDetected, type SessionStorage } from './store.ts';
import {
  handleFinishedDownload,
  reconcileDownloads,
  refreshBadge,
  type WatcherDeps,
} from './watcher.ts';

function memoryStorage(): SessionStorage {
  const data: Record<string, unknown> = {};
  return {
    get: (key) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
}

const RECEIPT: Receipt = {
  source: 'booksy',
  ticket: { number: '1167', issuedAt: '11/08/2026, 16:08:54' },
  merchant: { name: 'SALON EXEMPLE' },
  items: [{ label: 'Montant libre', total: 300 }],
  totals: { totalTTC: 300 },
  vat: [{ rate: 20, amount: 50, base: 250 }],
};

const PARSED: ParseResult = { receipt: RECEIPT, confidence: 1, warnings: [] };

const BOOKSY_DOWNLOAD: DownloadCandidate = {
  id: 42,
  filename: '/Users/x/Downloads/recu-1167.pdf',
  url: 'https://booksy.com/fr-fr/recu/1167.pdf',
  state: 'complete',
  exists: true,
};

let storage: SessionStorage;

function deps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    client: createMockNativeHostClient({ replies: { PARSE_RECEIPT: PARSED } }),
    storage,
    lookup: () => Promise.resolve(BOOKSY_DOWNLOAD),
    now: fixedClock(1_700),
    ...overrides,
  };
}

beforeEach(() => {
  storage = memoryStorage();
});

describe('handleFinishedDownload', () => {
  it('records a receipt the host recognised', async () => {
    const setBadge = vi.fn();
    const outcome = await handleFinishedDownload(42, deps({ setBadge }));

    expect(outcome.kind).toBe('detected');
    if (outcome.kind !== 'detected') return;
    expect(outcome.receipt).toMatchObject({
      downloadId: 42,
      path: '/Users/x/Downloads/recu-1167.pdf',
      ticketNumber: '1167',
      totalTTC: 300,
      confidence: 1,
      reason: 'booksy',
      detectedAt: 1_700,
    });
    expect(await readDetected(storage)).toHaveLength(1);
    expect(setBadge).toHaveBeenCalledWith(1);
  });

  it('only ever asks the host to READ, never to print', async () => {
    // Detection and printing are separate: the user is offered a button, and
    // automatic printing is a later phase behind its own setting.
    const client = createMockNativeHostClient({ replies: { PARSE_RECEIPT: PARSED } });
    await handleFinishedDownload(42, deps({ client }));
    expect(client.sent.map((message) => message.type)).toEqual(['PARSE_RECEIPT']);
  });

  it('hands the host a path, not the file contents', async () => {
    // Plan section 22: no PDF crosses the messaging channel.
    const client = createMockNativeHostClient({ replies: { PARSE_RECEIPT: PARSED } });
    await handleFinishedDownload(42, deps({ client }));
    expect(client.lastSent).toMatchObject({
      type: 'PARSE_RECEIPT',
      payload: { source: { kind: 'path', path: '/Users/x/Downloads/recu-1167.pdf' } },
    });
  });

  it('ignores a download the filter does not want', async () => {
    const client = createMockNativeHostClient({ replies: { PARSE_RECEIPT: PARSED } });
    const outcome = await handleFinishedDownload(
      42,
      deps({
        client,
        lookup: () =>
          Promise.resolve({
            ...BOOKSY_DOWNLOAD,
            url: 'https://ma-banque.example/releve.pdf',
            filename: '/Users/x/Downloads/releve.pdf',
          }),
      }),
    );
    expect(outcome).toEqual({ kind: 'ignored', why: 'not-a-candidate' });
    expect(client.sent).toEqual([]);
  });

  it('ignores a download it cannot look up', async () => {
    const outcome = await handleFinishedDownload(
      42,
      deps({ lookup: () => Promise.resolve(undefined) }),
    );
    expect(outcome).toEqual({ kind: 'ignored', why: 'unknown-download' });
  });

  it('records nothing when the host says it is not a Booksy receipt', async () => {
    // Expected for any PDF that simply is not one - the filename was never
    // proof, which is the whole reason the host is asked.
    const log = vi.fn();
    const client = createMockNativeHostClient({
      failWith: { code: 'NOT_BOOKSY', message: 'Ce PDF n’est pas un reçu Booksy.' },
    });
    const setBadge = vi.fn();

    const outcome = await handleFinishedDownload(42, deps({ client, log, setBadge }));
    expect(outcome).toMatchObject({ kind: 'rejected' });
    expect(await readDetected(storage)).toEqual([]);
    expect(setBadge).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it('notes when the filename was the weaker signal', async () => {
    const outcome = await handleFinishedDownload(
      42,
      deps({
        lookup: () =>
          Promise.resolve({ ...BOOKSY_DOWNLOAD, url: 'https://ailleurs.example/x.pdf' }),
      }),
    );
    expect(outcome.kind === 'detected' && outcome.receipt.reason).toBe('filename');
  });

  it('carries the parser warnings through as a count', async () => {
    const client = createMockNativeHostClient({
      replies: {
        PARSE_RECEIPT: {
          ...PARSED,
          confidence: 0.6,
          warnings: [{ code: 'ITEMS_SUM_MISMATCH', message: 'incohérent' }],
        },
      },
    });
    const outcome = await handleFinishedDownload(42, deps({ client }));
    expect(outcome.kind === 'detected' && outcome.receipt.warningCount).toBe(1);
    expect(outcome.kind === 'detected' && outcome.receipt.confidence).toBe(0.6);
  });

  it('does not duplicate a download that fires twice', async () => {
    await handleFinishedDownload(42, deps());
    await handleFinishedDownload(42, deps());
    expect(await readDetected(storage)).toHaveLength(1);
  });
});

describe('refreshBadge', () => {
  it('counts what awaits a decision', async () => {
    const setBadge = vi.fn();
    await handleFinishedDownload(42, deps({ setBadge }));
    expect(await refreshBadge(deps({ setBadge }))).toBe(1);
  });

  it('reports zero when nothing is pending', async () => {
    const setBadge = vi.fn();
    expect(await refreshBadge(deps({ setBadge }))).toBe(0);
    expect(setBadge).toHaveBeenCalledWith(0);
  });
});

describe('reconcileDownloads', () => {
  it('picks up a detection that was lost mid-flight', async () => {
    // An MV3 worker can be evicted while sendNativeMessage is in flight, and
    // the host process dies with it. Observed in a real browser: the download
    // finished, the host launched, the worker was shut down, and the
    // connection was never closed.
    const receipts = await reconcileDownloads(
      deps({ recent: () => Promise.resolve([BOOKSY_DOWNLOAD]) }),
    );
    expect(receipts.map((entry) => entry.ticketNumber)).toEqual(['1167']);
  });

  it('does not re-ask about a download already recorded', async () => {
    await handleFinishedDownload(42, deps());
    const client = createMockNativeHostClient({ replies: { PARSE_RECEIPT: PARSED } });
    await reconcileDownloads(
      deps({ client, recent: () => Promise.resolve([BOOKSY_DOWNLOAD]) }),
    );
    expect(client.sent).toEqual([]);
  });

  it('does not re-parse a PDF the host already rejected', async () => {
    // Otherwise every popup opening would hand the parser the same unrelated
    // documents again.
    const rejecting = createMockNativeHostClient({
      failWith: { code: 'NOT_BOOKSY', message: 'pas un reçu' },
    });
    await handleFinishedDownload(42, deps({ client: rejecting }));

    const second = createMockNativeHostClient({ replies: { PARSE_RECEIPT: PARSED } });
    await reconcileDownloads(
      deps({ client: second, recent: () => Promise.resolve([BOOKSY_DOWNLOAD]) }),
    );
    expect(second.sent).toEqual([]);
  });

  it('ignores recent downloads the filter does not want', async () => {
    const client = createMockNativeHostClient({ replies: { PARSE_RECEIPT: PARSED } });
    await reconcileDownloads(
      deps({
        client,
        recent: () =>
          Promise.resolve([
            { ...BOOKSY_DOWNLOAD, id: 1, filename: '/x/Downloads/releve.pdf', url: 'https://banque.example/x.pdf' },
            { ...BOOKSY_DOWNLOAD, id: 2, filename: '/x/Downloads/photo.png' },
            { ...BOOKSY_DOWNLOAD, id: 3, state: 'in_progress' },
          ]),
      }),
    );
    expect(client.sent).toEqual([]);
  });

  it('processes several missed downloads', async () => {
    const receipts = await reconcileDownloads(
      deps({
        lookup: (downloadId) =>
          Promise.resolve({ ...BOOKSY_DOWNLOAD, id: downloadId }),
        recent: () =>
          Promise.resolve([
            { ...BOOKSY_DOWNLOAD, id: 1 },
            { ...BOOKSY_DOWNLOAD, id: 2 },
          ]),
      }),
    );
    expect(receipts.map((entry) => entry.downloadId).sort()).toEqual([1, 2]);
  });

  it('just reads the list when no download source was given', async () => {
    await handleFinishedDownload(42, deps());
    const client = createMockNativeHostClient({ replies: { PARSE_RECEIPT: PARSED } });
    const receipts = await reconcileDownloads(deps({ client }));
    expect(receipts).toHaveLength(1);
    expect(client.sent).toEqual([]);
  });

  it('updates the badge with what awaits a decision', async () => {
    const setBadge = vi.fn();
    await reconcileDownloads(
      deps({ setBadge, recent: () => Promise.resolve([BOOKSY_DOWNLOAD]) }),
    );
    expect(setBadge).toHaveBeenLastCalledWith(1);
  });
});
