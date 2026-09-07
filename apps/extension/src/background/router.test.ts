import { describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  type ConfigData,
  type ListPrintersData,
  type PingData,
  type StatusData,
} from '@brb/shared';
import { MockNativeHostClient } from '../messaging/mock-client.ts';
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

function deps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    client: new MockNativeHostClient({ replies: { PING: PING, GET_STATUS: STATUS } }),
    extensionId: EXTENSION_ID,
    ...overrides,
  };
}

describe('handleExtensionMessage - sender check', () => {
  it('refuses a message from another extension', async () => {
    // onMessage is reachable from this extension's content scripts, which run
    // alongside a web page. Without this check the worker is an open relay to
    // the native host.
    const log = vi.fn();
    const client = new MockNativeHostClient();
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
    const client = new MockNativeHostClient();
    const response = await handleExtensionMessage({ kind: 'PING_HOST' }, {}, deps({ client }));
    expect(response.kind).toBe('ERROR');
    expect(client.sent).toEqual([]);
  });
});

describe('handleExtensionMessage - validation', () => {
  it('refuses an unknown internal message', async () => {
    const client = new MockNativeHostClient();
    for (const raw of [null, 'GET_HOST_STATE', {}, { kind: 'RUN_ANYTHING' }, { kind: 7 }]) {
      const response = await handleExtensionMessage(raw, { id: EXTENSION_ID }, deps({ client }));
      expect(response).toEqual({ kind: 'ERROR', message: 'Message interne inconnu.' });
    }
    expect(client.sent).toEqual([]);
  });

  it('does not forward an arbitrary native message type from a caller', async () => {
    // The internal protocol is a closed set of intents, not a passthrough: a
    // content script cannot name a native message type and have it relayed.
    const client = new MockNativeHostClient({ replies: { PING: PING, GET_STATUS: STATUS } });
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
    const client = new MockNativeHostClient({
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
    const client = new MockNativeHostClient({ replies: { PING: PING, GET_STATUS: STATUS } });
    const response = await handleExtensionMessage(
      { kind: 'PING_HOST' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toMatchObject({ kind: 'HOST_STATE' });
    expect(client.sent.map((message) => message.type)).toEqual(['PING', 'PING', 'GET_STATUS']);
  });

  it('reports the host error message when the ping fails', async () => {
    const client = new MockNativeHostClient({
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
    printer: { name: 'EPSON TM-T88V Receipt5', paperWidth: 80, printableWidth: 72, columns: 42 },
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
    const client = new MockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'SET_CONFIG', patch: { printer: { name: 'Autre' } } },
      fromTab,
      deps({ client }),
    );
    expect(response).toEqual({ kind: 'ERROR', message: 'Action non autorisée depuis une page.' });
    expect(client.sent).toEqual([]);
  });

  it('refuses PRINT_TEST', async () => {
    const client = new MockNativeHostClient({ replies: { PRINT_TEST: {} } });
    const response = await handleExtensionMessage({ kind: 'PRINT_TEST' }, fromTab, deps({ client }));
    expect(response.kind).toBe('ERROR');
    expect(client.sent).toEqual([]);
  });

  it('allows those same intents from an extension page', async () => {
    const client = new MockNativeHostClient({ replies: { PRINT_TEST: { bytesSent: 700 } } });
    const response = await handleExtensionMessage(
      { kind: 'PRINT_TEST' },
      { id: EXTENSION_ID, origin: `chrome-extension://${EXTENSION_ID}` },
      deps({ client }),
    );
    expect(response).toEqual({ kind: 'PRINTED', data: { bytesSent: 700 } });
  });

  it('allows an extension page that is open in a tab', async () => {
    // Regression: the options page declares open_in_tab, so it arrives with a
    // tab set and was refused every save.
    const client = new MockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
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
    const client = new MockNativeHostClient({ replies: { PRINT_TEST: {} } });
    const response = await handleExtensionMessage(
      { kind: 'PRINT_TEST' },
      { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/index.html` },
      deps({ client }),
    );
    expect(response.kind).toBe('PRINTED');
  });

  it('refuses a page whose origin merely starts like ours', async () => {
    const client = new MockNativeHostClient({ replies: { PRINT_TEST: {} } });
    const response = await handleExtensionMessage(
      { kind: 'PRINT_TEST' },
      { id: EXTENSION_ID, origin: `chrome-extension://${EXTENSION_ID}evil` },
      deps({ client }),
    );
    expect(response.kind).toBe('ERROR');
    expect(client.sent).toEqual([]);
  });
});

describe('handleExtensionMessage - LIST_PRINTERS', () => {
  it('returns the queues and the driver that answered', async () => {
    const client = new MockNativeHostClient({ replies: { LIST_PRINTERS: PRINTERS } });
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
    const client = new MockNativeHostClient({
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
    const client = new MockNativeHostClient({ replies: { GET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'GET_CONFIG' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toEqual({ kind: 'CONFIG', config: CONFIG.config, present: true });
  });

  it('forwards the patch to the host and returns what it stored', async () => {
    const client = new MockNativeHostClient({ replies: { SET_CONFIG: CONFIG } });
    const response = await handleExtensionMessage(
      { kind: 'SET_CONFIG', patch: { printer: { name: 'EPSON TM-T88V Receipt5' } } },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toMatchObject({ kind: 'CONFIG', present: true });
    expect(client.lastSent).toEqual({
      id: expect.any(String),
      type: 'SET_CONFIG',
      payload: { printer: { name: 'EPSON TM-T88V Receipt5' } },
    });
  });

  it('surfaces a configuration file error alongside the values', async () => {
    const client = new MockNativeHostClient({
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

describe('handleExtensionMessage - PRINT_TEST', () => {
  it('reports the substituted characters so they can be shown', async () => {
    const client = new MockNativeHostClient({
      replies: { PRINT_TEST: { bytesSent: 766, unmapped: ['’', 'œ'] } },
    });
    const response = await handleExtensionMessage(
      { kind: 'PRINT_TEST' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response).toEqual({
      kind: 'PRINTED',
      data: { bytesSent: 766, unmapped: ['’', 'œ'] },
    });
  });

  it('reports a print failure as an error', async () => {
    const client = new MockNativeHostClient();
    const response = await handleExtensionMessage(
      { kind: 'PRINT_TEST' },
      { id: EXTENSION_ID },
      deps({ client }),
    );
    expect(response.kind).toBe('ERROR');
  });
});
