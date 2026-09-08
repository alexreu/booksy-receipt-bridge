import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type PingData, type StatusData } from '@brb/shared';
import { createMockNativeHostClient } from './mock-client.ts';
import { describeHostState, hostChecklist, resolveHostState, type HostState } from './state.ts';

const PING: PingData = { status: 'ready', version: '1.2.3', protocolVersion: PROTOCOL_VERSION };

function statusData(overrides: Partial<StatusData> = {}): StatusData {
  return {
    status: 'ready',
    version: '1.2.3',
    protocolVersion: PROTOCOL_VERSION,
    printerConfigured: true,
    printerName: 'EPSON TM-T88V Receipt5',
    printerFound: true,
    configPresent: true,
    printerAdapter: 'windows',
    supported: ['PING', 'GET_STATUS', 'PRINT_TEST'],
    ...overrides,
  };
}

describe('resolveHostState', () => {
  it('reports connected when the host answers both calls', async () => {
    const client = createMockNativeHostClient({
      replies: { PING: PING, GET_STATUS: statusData() },
    });
    const state = await resolveHostState(client);
    expect(state).toEqual({ kind: 'connected', version: '1.2.3', status: statusData() });
  });

  it('pings before asking for status', async () => {
    // PING is the cheapest possible answer to "is anything there at all".
    const client = createMockNativeHostClient({
      replies: { PING: PING, GET_STATUS: statusData() },
    });
    await resolveHostState(client);
    expect(client.sent.map((message) => message.type)).toEqual(['PING', 'GET_STATUS']);
  });

  it('reports unavailable when the host is not installed', async () => {
    const client = createMockNativeHostClient({
      failWith: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
    });
    const state = await resolveHostState(client);
    expect(state).toEqual({
      kind: 'unavailable',
      error: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
    });
  });

  it('does not ask for status once the ping failed', async () => {
    const client = createMockNativeHostClient({
      failWith: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
    });
    await resolveHostState(client);
    expect(client.sent.map((message) => message.type)).toEqual(['PING']);
  });

  it('stops at a protocol mismatch rather than reading a shape it may not know', async () => {
    const client = createMockNativeHostClient({
      replies: {
        PING: { status: 'ready', version: '0.0.1', protocolVersion: PROTOCOL_VERSION + 1 },
        GET_STATUS: statusData(),
      },
    });
    const state = await resolveHostState(client);
    expect(state).toEqual({
      kind: 'version-mismatch',
      hostVersion: '0.0.1',
      hostProtocol: PROTOCOL_VERSION + 1,
      expected: PROTOCOL_VERSION,
    });
    expect(client.sent.map((message) => message.type)).toEqual(['PING']);
  });

  it('reports unavailable when the status call fails', async () => {
    const client = createMockNativeHostClient({ replies: { PING: PING } });
    const state = await resolveHostState(client);
    expect(state.kind).toBe('unavailable');
  });

  it('reports unavailable on a success with no data', async () => {
    const empty = {
      send: () => Promise.resolve({ id: '1', success: true }),
    };
    const state = await resolveHostState(empty);
    expect(state).toMatchObject({ kind: 'unavailable' });
    expect(state.kind === 'unavailable' && state.error.detail).toContain('vide');
  });
});

describe('describeHostState', () => {
  it('has a line for every state', () => {
    const states: HostState[] = [
      { kind: 'checking' },
      { kind: 'unavailable', error: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' } },
      { kind: 'version-mismatch', hostVersion: '0.1', hostProtocol: 2, expected: 1 },
      { kind: 'connected', version: '1.2.3', status: statusData() },
    ];
    for (const state of states) {
      expect(describeHostState(state)).not.toBe('');
    }
  });

  it('shows the host error text verbatim when unavailable', () => {
    expect(
      describeHostState({
        kind: 'unavailable',
        error: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé sur ce PC' },
      }),
    ).toBe('pas installé sur ce PC');
  });

  it('says "Service connecté" when connected', () => {
    expect(describeHostState({ kind: 'connected', version: '1', status: statusData() })).toBe(
      'Service connecté',
    );
  });
});

describe('hostChecklist', () => {
  it('ticks everything on a fully configured host', () => {
    const items = hostChecklist({ kind: 'connected', version: '1.2.3', status: statusData() });
    expect(items.every((item) => item.ok)).toBe(true);
    expect(items.map((item) => item.label)).toEqual([
      'Service installé',
      'Configuration',
      'Imprimante configurée',
      'Imprimante détectée',
    ]);
  });

  it('reads as connected-but-incomplete when no printer is chosen', () => {
    // Independent items, so a host that answers but is not set up does not read
    // as broken.
    const items = hostChecklist({
      kind: 'connected',
      version: '1.2.3',
      status: statusData({ printerConfigured: false, printerFound: false, printerName: undefined }),
    });
    expect(items[0]?.ok).toBe(true);
    expect(items.find((item) => item.label === 'Imprimante configurée')?.ok).toBe(false);
  });

  it('names the driver that answered, so a mock cannot pass for real', () => {
    const items = hostChecklist({
      kind: 'connected',
      version: '1.2.3',
      status: statusData({ printerFound: false, printerAdapter: 'mock' }),
    });
    expect(items.find((item) => item.label === 'Imprimante détectée')?.detail).toContain('mock');
  });

  it('collapses to a single failed item when the host is unreachable', () => {
    const items = hostChecklist({
      kind: 'unavailable',
      error: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ok: false, detail: 'pas installé' });
  });
});
