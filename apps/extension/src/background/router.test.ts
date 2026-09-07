import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type PingData, type StatusData } from '@brb/shared';
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
