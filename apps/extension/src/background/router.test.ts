import { describe, expect, it, vi } from 'vitest';
import {
  fixedClock,
  PROTOCOL_VERSION,
  type ConfigData,
  type ListPrintersData,
  type PingData,
  type StatusData,
} from '@brb/shared';
import { createMockNativeHostClient } from '../messaging/mock-client.ts';
import { PENDING_KEY } from '../preview/pending.ts';
import { handleExtensionMessage, type RouterDeps } from './router.ts';

const EXTENSION_ID = 'ndfcmfgnelpdjgpmaelpdgoccmjcpdjm';
const PING: PingData = { status: 'ready', version: '1.2.3', protocolVersion: PROTOCOL_VERSION };

const STATUS: StatusData = {
  status: 'ready',
  version: '1.2.3',
  protocolVersion: PROTOCOL_VERSION,
  printerConfigured: true,
  printerFound: true,
  configPresent: true,
  printerAdapter: 'mock',
  supported: ['PING', 'GET_STATUS'],
};

/** A stand-in for chrome.storage.session, which tests must not need. */
function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    get: (key: string) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items: Record<string, unknown>) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
    snapshot: () => data,
  };
}

function deps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    client: createMockNativeHostClient({ replies: { PING: PING, GET_STATUS: STATUS } }),
    extensionId: EXTENSION_ID,
    storage: memoryStorage(),
    clock: fixedClock(1_700_000_000_000),
    ...overrides,
  };
}

describe('handleExtensionMessage - sender check', () => {
  it('refuses a message from another extension', async () => {
    // onMessage is reachable from this extension's content scripts, which run
    // alongside a web page. Without this check the worker is an open relay to
    // the native host.
    const log = vi.fn();
    const client = createMockNativeHostClient();
    const response = await handleExtensionMessage(
      { kind: 'GET_HOST_STATE' },
      { id: 'someone-else' },
      deps({ client, log }),
    );
    expect(response).toEqual({ kind: 'ERROR', message: 'Expéditeur non autorisé.' });
    expect(client.sent).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it('refuses a message with no sender id', async () => {
    const client = createMockNativeHostClient();
    const response = await handleExtensionMessage({ kind: 'PING_HOST' }, {}, deps({ client }));
    expect(response.kind).toBe('ERROR');
    expect(client.sent).toEqual([]);
  });
});

describe('handleExtensionMessage - validation', () => {
  it('refuses an unknown internal message', async () => {
    const client = createMockNativeHostClient();
    for (const raw of [null, 'GET_HOST_STATE', {}, { kind: 'RUN_ANYTHING' }, { kind: 7 }]) {
      const response = await handleExtensionMessage(raw, { id: EXTENSION_ID }, deps({ client }));
      expect(response).toEqual({ kind: 'ERROR', message: 'Message interne inconnu.' });
    }
    expect(client.sent).toEqual([]);
  });

  it('does not forward an arbitrary native message type from a caller', async () => {
    // The internal protocol is a closed set of intents, not a passthrough: a
    // content script cannot name a native message type and have it relayed.
    const client = createMockNativeHostClient({ replies: { PING: PING, GET_STATUS: STATUS } });
    await handleExtensionMessage(
      { kind: 'GET_HOST_STATE', type: 'PRINT_RECEIPT' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(client.sent.map((message) => message.type)).toEqual(['PING', 'GET_STATUS']);
  });
});

describe('handleExtensionMessage - GET_HOST_STATE', () => {
  it('returns the resolved host state', async () => {
    const response = await handleExtensionMessage(
      { kind: 'GET_HOST_STATE' },
      { id: EXTENSION_ID },
      deps(),
    );
    expect(response).toEqual({
      kind: 'HOST_STATE',
      state: { kind: 'connected', version: '1.2.3', status: STATUS },
    });
  });

  it('returns an unavailable state rather than an error when the host is absent', async () => {
    const client = createMockNativeHostClient({
      failWith: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
    });
    const response = await handleExtensionMessage(
      { kind: 'GET_HOST_STATE' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toMatchObject({ kind: 'HOST_STATE', state: { kind: 'unavailable' } });
  });
});

describe('handleExtensionMessage - PING_HOST', () => {
  it('pings then returns the full state', async () => {
    const client = createMockNativeHostClient({ replies: { PING: PING, GET_STATUS: STATUS } });
    const response = await handleExtensionMessage(
      { kind: 'PING_HOST' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toMatchObject({ kind: 'HOST_STATE' });
    expect(client.sent.map((message) => message.type)).toEqual(['PING', 'PING', 'GET_STATUS']);
  });

  it('reports the host error message when the ping fails', async () => {
    const client = createMockNativeHostClient({
      failWith: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé sur ce PC' },
    });
    const response = await handleExtensionMessage(
      { kind: 'PING_HOST' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toEqual({ kind: 'ERROR', message: 'pas installé sur ce PC' });
  });
});

const CONFIG: ConfigData = {
  config: {
    printer: {
      kind: 'thermal',
      name: 'EPSON TM-T88V Receipt5',
      paperWidth: 80,
      printableWidth: 72,
      columns: 42,
    },
    update: { repo: 'alexreu/booksy-receipt-bridge', token: '' },
    printing: { autoPrint: false, showPreview: true, confidenceThreshold: 0.9, allowedDirs: [] },
  },
  present: true,
};

const PRINTERS: ListPrintersData = {
  printers: [{ name: 'EPSON TM-T88V Receipt5', isDefault: true }],
  adapter: 'windows',
};

describe('handleExtensionMessage - a content script gets read-only access', () => {
  // A content script runs alongside a web page. It may need to know whether the
  // service is up; nothing in a page should be able to repoint the printer or
  // start a print job.
  //
  // Identified by ORIGIN, not by carrying a tab: the options page is opened in
  // a tab too, and keying on that blocked it from saving.
  const fromTab = {
    id: EXTENSION_ID,
    origin: 'https://booksy.com',
    url: 'https://booksy.com/fr-fr/recu/1167',
  };

  it('allows the read-only intents', async () => {
    const response = await handleExtensionMessage({ kind: 'GET_HOST_STATE' }, fromTab, deps());
    expect(response.kind).toBe('HOST_STATE');
  });

  it('refuses SET_CONFIG', async () => {
    const client = createMockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'SET_CONFIG', patch: { printer: { name: 'Autre' } } },
      fromTab,
      deps({ client }),
    );
    expect(response).toEqual({ kind: 'ERROR', message: 'Action non autorisée depuis une page.' });
    expect(client.sent).toEqual([]);
  });

  it('refuses to start a print job', async () => {
    const client = createMockNativeHostClient();
    const response = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromTab,
      deps({ client, fetchActiveTab: () => Promise.resolve(new Uint8Array([1])) }),
    );
    expect(response.kind).toBe('ERROR');
    expect(client.sent).toEqual([]);
  });

  it('allows those same intents from an extension page', async () => {
    const client = createMockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'SET_CONFIG', patch: { printer: { name: 'Autre' } } },
      { id: EXTENSION_ID, origin: `chrome-extension://${EXTENSION_ID}` },
      deps({ client }),
    );
    expect(response.kind).toBe('CONFIG');
  });

  it('allows an extension page that is open in a tab', async () => {
    // Regression: the options page declares open_in_tab, so it arrives with a
    // tab set and was refused every save.
    const client = createMockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'SET_CONFIG', patch: { printer: { name: 'X' } } },
      {
        id: EXTENSION_ID,
        origin: `chrome-extension://${EXTENSION_ID}`,
        url: `chrome-extension://${EXTENSION_ID}/options/index.html`,
      },
      deps({ client }),
    );
    expect(response.kind).toBe('CONFIG');
  });

  it('falls back to the page URL when Chrome omits the origin', async () => {
    const client = createMockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'SET_CONFIG', patch: { printer: { name: 'Autre' } } },
      { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/index.html` },
      deps({ client }),
    );
    expect(response.kind).toBe('CONFIG');
  });

  it('refuses a page whose origin merely starts like ours', async () => {
    const client = createMockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'SET_CONFIG', patch: { printer: { name: 'Autre' } } },
      { id: EXTENSION_ID, origin: `chrome-extension://${EXTENSION_ID}evil` },
      deps({ client }),
    );
    expect(response.kind).toBe('ERROR');
    expect(client.sent).toEqual([]);
  });
});

describe('handleExtensionMessage - LIST_PRINTERS', () => {
  it('returns the queues and the driver that answered', async () => {
    const client = createMockNativeHostClient({ replies: { LIST_PRINTERS: PRINTERS } });
    const response = await handleExtensionMessage(
      { kind: 'LIST_PRINTERS' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toEqual({
      kind: 'PRINTERS',
      printers: PRINTERS.printers,
      adapter: 'windows',
    });
  });

  it('reports the host error rather than an empty list', async () => {
    // An empty list and a failed call mean different things to the user.
    const client = createMockNativeHostClient({
      failWith: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
    });
    const response = await handleExtensionMessage(
      { kind: 'LIST_PRINTERS' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toEqual({ kind: 'ERROR', message: 'pas installé' });
  });
});

describe('handleExtensionMessage - configuration', () => {
  it('reads the configuration', async () => {
    const client = createMockNativeHostClient({ replies: { GET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'GET_CONFIG' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toEqual({ kind: 'CONFIG', config: CONFIG.config, present: true });
  });

  it('forwards the patch to the host and returns what it stored', async () => {
    const client = createMockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'SET_CONFIG', patch: { printer: { kind: 'thermal' as const, name: 'EPSON TM-T88V Receipt5' } } },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toMatchObject({ kind: 'CONFIG', present: true });
    expect(client.lastSent).toEqual({
      id: expect.any(String),
      type: 'SET_CONFIG',
      payload: { printer: { kind: 'thermal' as const, name: 'EPSON TM-T88V Receipt5' } },
    });
  });

  it('surfaces a configuration file error alongside the values', async () => {
    const client = createMockNativeHostClient({
      replies: { GET_CONFIG: { ...CONFIG, error: 'fichier illisible' } },
    });
    const response = await handleExtensionMessage(
      { kind: 'GET_CONFIG' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toMatchObject({ kind: 'CONFIG', error: 'fichier illisible' });
  });
});

describe('handleExtensionMessage - the PDF in the active tab', () => {
  const fromPage = { id: EXTENSION_ID, origin: `chrome-extension://${EXTENSION_ID}` };
  const PDF = { name: 'recu-1167.pdf', url: 'https://booksy.com/recu/1167.pdf' };

  it('reports what the tab is showing', async () => {
    const response = await handleExtensionMessage(
      { kind: 'GET_ACTIVE_TAB' },
      fromPage,
      deps({ activeTabPdf: () => Promise.resolve({ pdf: PDF }) }),
    );
    expect(response).toEqual({ kind: 'ACTIVE_TAB', pdf: PDF });
  });

  it('reports nothing when the tab is not a PDF, and says why', async () => {
    const response = await handleExtensionMessage(
      { kind: 'GET_ACTIVE_TAB' },
      fromPage,
      deps({ activeTabPdf: () => Promise.resolve({ pdf: null, reason: 'not-a-pdf' }) }),
    );
    expect(response).toEqual({ kind: 'ACTIVE_TAB', pdf: null, reason: 'not-a-pdf' });
  });

  it('distinguishes a tab it was never given access to', async () => {
    // activeTab is granted only when the user invokes the extension, and until
    // then tabs.query returns a tab with no url. Saying "not a PDF" about a tab
    // that plainly is one would send the user looking in the wrong place.
    const response = await handleExtensionMessage(
      { kind: 'GET_ACTIVE_TAB' },
      fromPage,
      deps({ activeTabPdf: () => Promise.resolve({ pdf: null, reason: 'no-permission' }) }),
    );
    expect(response).toMatchObject({ pdf: null, reason: 'no-permission' });
  });

  it('lets a page script ask what the tab shows, which reveals nothing new', async () => {
    const response = await handleExtensionMessage(
      { kind: 'GET_ACTIVE_TAB' },
      { id: EXTENSION_ID, origin: 'https://booksy.com' },
      deps({ activeTabPdf: () => Promise.resolve({ pdf: PDF }) }),
    );
    expect(response.kind).toBe('ACTIVE_TAB');
  });
});

describe('handleExtensionMessage - the approval page', () => {
  const fromPage = { id: EXTENSION_ID, origin: `chrome-extension://${EXTENSION_ID}` };
  const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const RENDERED = {
    format: 'svg' as const,
    content: '<svg/>',
    ticketNumber: '1167',
    confidence: 1,
    warnings: [],
    columns: 42,
    byteCount: 856,
  };

  it('captures the active tab once, because a tab has no path to re-read', async () => {
    const opened: string[] = [];
    const response = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      deps({
        fetchActiveTab: () => Promise.resolve(BYTES),
        activeTabPdf: () => Promise.resolve({ pdf: { name: 'recu.pdf', url: 'https://x/y.pdf' } }),
        openPreview: (id) => {
          opened.push(id);
        },
      }),
    );
    expect(response).toMatchObject({ kind: 'PREVIEW_READY', label: 'recu.pdf' });
    expect(opened).toHaveLength(1);
  });

  it('renders the captured bytes at the configured width', async () => {
    const client = createMockNativeHostClient({ replies: { RENDER_RECEIPT: RENDERED } });
    const shared = deps({ client, fetchActiveTab: () => Promise.resolve(BYTES) });

    const prepared = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      shared,
    );
    if (prepared.kind !== 'PREVIEW_READY') throw new Error('préparation échouée');

    await handleExtensionMessage({ kind: 'RENDER_PREVIEW', id: prepared.id }, fromPage, shared);
    expect(client.lastSent).toMatchObject({
      type: 'RENDER_RECEIPT',
      payload: { source: { kind: 'bytes', base64: 'JVBERg==' }, format: 'svg' },
    });
  });

  it('sends the label back with the render, so the page holds only an id', async () => {
    const client = createMockNativeHostClient({ replies: { RENDER_RECEIPT: RENDERED } });
    const shared = deps({
      client,
      fetchActiveTab: () => Promise.resolve(BYTES),
      activeTabPdf: () => Promise.resolve({ pdf: { name: 'recu-1167.pdf', url: 'https://x/y' } }),
    });

    const prepared = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      shared,
    );
    if (prepared.kind !== 'PREVIEW_READY') throw new Error('préparation échouée');

    const rendered = await handleExtensionMessage(
      { kind: 'RENDER_PREVIEW', id: prepared.id },
      fromPage,
      shared,
    );
    expect(rendered).toMatchObject({ kind: 'PREVIEW', label: 'recu-1167.pdf' });
  });

  it('hands a local PDF over as a path, so the service opens it itself', async () => {
    // The browser has no business reading a file from disk, and the service
    // re-validates the path against its allowed directories every call.
    const client = createMockNativeHostClient({ replies: { RENDER_RECEIPT: RENDERED } });
    const shared = deps({
      client,
      activeTabPdf: () =>
        Promise.resolve({
          pdf: { name: 'recu-1167.pdf', url: 'file:///Users/x/Downloads/recu-1167.pdf' },
        }),
      fetchActiveTab: () => Promise.reject(new Error('le worker ne doit pas lire le fichier')),
    });

    const prepared = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      shared,
    );
    if (prepared.kind !== 'PREVIEW_READY') throw new Error('préparation échouée');

    await handleExtensionMessage({ kind: 'RENDER_PREVIEW', id: prepared.id }, fromPage, shared);
    expect(client.lastSent).toMatchObject({
      type: 'RENDER_RECEIPT',
      payload: { source: { kind: 'path', path: '/Users/x/Downloads/recu-1167.pdf' } },
    });
  });

  it('still fetches an http PDF as bytes, having no path to re-read', async () => {
    const client = createMockNativeHostClient({ replies: { RENDER_RECEIPT: RENDERED } });
    const shared = deps({
      client,
      activeTabPdf: () =>
        Promise.resolve({ pdf: { name: 'recu.pdf', url: 'https://booksy.com/recu/1167.pdf' } }),
      fetchActiveTab: () => Promise.resolve(BYTES),
    });

    const prepared = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      shared,
    );
    if (prepared.kind !== 'PREVIEW_READY') throw new Error('préparation échouée');

    await handleExtensionMessage({ kind: 'RENDER_PREVIEW', id: prepared.id }, fromPage, shared);
    expect(client.lastSent).toMatchObject({
      type: 'RENDER_RECEIPT',
      payload: { source: { kind: 'bytes', base64: 'JVBERg==' } },
    });
  });

  it('says so plainly when there is no tab to capture', async () => {
    const response = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      deps(),
    );
    expect(response).toEqual({ kind: 'ERROR', message: 'Aucun onglet à imprimer.' });
  });

  it('reports a failed capture without asking the host for anything', async () => {
    const client = createMockNativeHostClient();
    const response = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      deps({ client, fetchActiveTab: () => Promise.reject(new Error('403')) }),
    );
    expect(response.kind).toBe('ERROR');
    expect(client.sent).toEqual([]);
  });

  it('prints the same bytes it rendered, on the printer chosen on the page', async () => {
    const client = createMockNativeHostClient({
      replies: {
        RENDER_RECEIPT: RENDERED,
        PRINT_RECEIPT: { ticketNumber: '1167', confidence: 1, warnings: [] },
      },
    });
    const shared = deps({ client, fetchActiveTab: () => Promise.resolve(BYTES) });

    const prepared = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      shared,
    );
    if (prepared.kind !== 'PREVIEW_READY') throw new Error('préparation échouée');

    const printed = await handleExtensionMessage(
      { kind: 'PRINT_PREVIEW', id: prepared.id, printerName: 'Autre' },
      fromPage,
      shared,
    );
    expect(printed.kind).toBe('PRINTED_RECEIPT');
    expect(client.lastSent).toMatchObject({
      type: 'PRINT_RECEIPT',
      payload: {
        source: { kind: 'bytes', base64: 'JVBERg==' },
        printerName: 'Autre',
        trigger: 'user',
      },
    });
  });

  it('leaves the preview open when the print failed', async () => {
    // The point of an approval page is being able to try again after fixing
    // the printer.
    const storage = memoryStorage();
    const client = createMockNativeHostClient({
      replies: { RENDER_RECEIPT: RENDERED },
      failWith: { code: 'PRINTER_OFFLINE', message: 'hors ligne' },
    });
    const shared = deps({ storage, client, fetchActiveTab: () => Promise.resolve(BYTES) });

    const prepared = await handleExtensionMessage(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
      fromPage,
      shared,
    );
    if (prepared.kind !== 'PREVIEW_READY') throw new Error('préparation échouée');

    const printed = await handleExtensionMessage(
      { kind: 'PRINT_PREVIEW', id: prepared.id },
      fromPage,
      shared,
    );
    expect(printed.kind).toBe('ERROR');

    // Asserted on the store rather than by rendering again: the mock fails
    // every call once told to, so a second render would fail for its own
    // reason and prove nothing.
    const stored = storage.snapshot()[PENDING_KEY] as { id: string }[] | undefined;
    expect(stored?.map((entry) => entry.id)).toEqual([prepared.id]);
  });

  it('refuses every preview intent from a page context', async () => {
    const client = createMockNativeHostClient();
    const fromTab = { id: EXTENSION_ID, origin: 'https://booksy.com' };
    for (const request of [
      { kind: 'PREPARE_PREVIEW' as const, source: { kind: 'activeTab' as const } },
      { kind: 'RENDER_PREVIEW' as const, id: 'p-1' },
      { kind: 'PRINT_PREVIEW' as const, id: 'p-1' },
    ]) {
      const response = await handleExtensionMessage(request, fromTab, deps({ client }));
      expect(response.kind, request.kind).toBe('ERROR');
    }
    expect(client.sent).toEqual([]);
  });

  it('says so when an approval has expired', async () => {
    const response = await handleExtensionMessage(
      { kind: 'RENDER_PREVIEW', id: 'p-inconnu' },
      fromPage,
      deps(),
    );
    expect(response).toMatchObject({ kind: 'ERROR' });
  });
});
