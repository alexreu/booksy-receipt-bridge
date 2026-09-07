import { describe, expect, it, vi } from 'vitest';
import { MockPrinterAdapter, type PrinterAdapter } from '@brb/printer';
import { MAX_RESPONSE_BYTES, type NativeResponse, type StatusData } from '@brb/shared';
import { DEFAULT_CONFIG, type ConfigState } from '../config/config.ts';
import { silentLogger } from '../logging/logger.ts';
import { SUPPORTED, dispatch, withinResponseLimit, type HostContext } from './dispatch.ts';

const PRINTER_NAME = 'EPSON TM-T88V Receipt5';

function context(overrides: Partial<HostContext> = {}): HostContext {
  return {
    version: '9.9.9',
    config: { config: DEFAULT_CONFIG, present: false } satisfies ConfigState,
    printer: new MockPrinterAdapter(),
    printerAdapter: 'mock',
    log: silentLogger(),
    ...overrides,
  };
}

function configured(name = PRINTER_NAME): ConfigState {
  return {
    config: { ...DEFAULT_CONFIG, printer: { ...DEFAULT_CONFIG.printer, name } },
    present: true,
  };
}

async function statusOf(overrides: Partial<HostContext> = {}): Promise<StatusData> {
  const response = await dispatch({ id: '1', type: 'GET_STATUS' }, context(overrides));
  expect(response.success).toBe(true);
  return response.data as StatusData;
}

describe('dispatch - PING', () => {
  it('answers ready with the host and protocol versions', async () => {
    const response = await dispatch({ id: 'abc123', type: 'PING' }, context());
    expect(response).toEqual({
      id: 'abc123',
      success: true,
      data: { status: 'ready', version: '9.9.9', protocolVersion: 1 },
    });
  });

  it('echoes the id it was given, so the caller can correlate', async () => {
    const response = await dispatch({ id: 'zzz', type: 'PING' }, context());
    expect(response.id).toBe('zzz');
  });
});

describe('dispatch - GET_STATUS', () => {
  it('reports degraded with nothing configured', async () => {
    const status = await statusOf();
    expect(status).toMatchObject({
      status: 'degraded',
      printerConfigured: false,
      printerFound: false,
      configPresent: false,
    });
  });

  it('reports ready when the configured printer is present', async () => {
    const status = await statusOf({
      config: configured(),
      printer: new MockPrinterAdapter({ printers: [{ name: PRINTER_NAME }] }),
    });
    expect(status).toMatchObject({
      status: 'ready',
      printerConfigured: true,
      printerFound: true,
      configPresent: true,
    });
  });

  it('reports the printer as not found when the configured name is absent', async () => {
    const status = await statusOf({
      config: configured(),
      printer: new MockPrinterAdapter({ printers: [{ name: 'Autre imprimante' }] }),
    });
    expect(status.printerConfigured).toBe(true);
    expect(status.printerFound).toBe(false);
    expect(status.status).toBe('degraded');
  });

  it('names the wired implementation, so a mock cannot masquerade as real', async () => {
    // Otherwise the popup shows a green tick because a mock answered.
    const status = await statusOf({ printerAdapter: 'mock' });
    expect(status.printerAdapter).toBe('mock');
  });

  it('declares which message types it implements', async () => {
    const status = await statusOf();
    expect(status.supported).toEqual(['PING', 'GET_STATUS']);
    expect(status.supported).toEqual(SUPPORTED);
  });

  it('survives a printer backend that throws', async () => {
    const failing: PrinterAdapter = {
      list: () => Promise.reject(new Error('spooler indisponible')),
      printRaw: () => Promise.reject(new Error('nope')),
      printTest: () => Promise.reject(new Error('nope')),
    };
    const log = silentLogger();
    const warn = vi.spyOn(log, 'warn');

    const status = await statusOf({ config: configured(), printer: failing, log });
    expect(status.printerFound).toBe(false);
    expect(status.status).toBe('degraded');
    expect(warn).toHaveBeenCalled();
  });
});

describe('dispatch - refusals', () => {
  it('refuses an unknown message type', async () => {
    const response = await dispatch({ id: '1', type: 'DROP_TABLES' }, context());
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('INVALID_MESSAGE');
    expect(response.error?.detail).toContain('type');
  });

  it('refuses a known type this version does not implement', async () => {
    // A valid protocol message that will arrive in a later phase must not be
    // reported as malformed.
    const response = await dispatch({ id: '1', type: 'LIST_PRINTERS' }, context());
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('NOT_IMPLEMENTED');
    expect(response.error?.detail).toContain('LIST_PRINTERS');
  });

  it('refuses PRINT_RECEIPT for now rather than pretending', async () => {
    const response = await dispatch(
      { id: '1', type: 'PRINT_RECEIPT', payload: { source: { kind: 'path', path: 'x.pdf' } } },
      context(),
    );
    expect(response.error?.code).toBe('NOT_IMPLEMENTED');
  });

  it('recovers the id from a message that failed validation', async () => {
    const response = await dispatch({ id: 'keep-me', type: 'NOPE' }, context());
    expect(response.id).toBe('keep-me');
  });

  it('falls back to a placeholder id when there is none to recover', async () => {
    for (const raw of [null, 'PING', [], 42, {}, { type: 'PING' }, { id: 7, type: 'PING' }]) {
      const response = await dispatch(raw, context());
      expect(response.success).toBe(false);
      expect(response.id).toBe('unknown');
    }
  });

  it('never throws, whatever it is handed', async () => {
    // A host that dies on a bad message looks exactly like a host that is not
    // installed, which is the least diagnosable failure there is.
    const hostile: unknown[] = [
      undefined,
      Number.NaN,
      { id: 'x', type: 'PING', extra: { deeply: { nested: true } } },
      { id: 'x'.repeat(10_000), type: 'PING' },
    ];
    for (const raw of hostile) {
      await expect(dispatch(raw, context())).resolves.toHaveProperty('id');
    }
  });

  it('carries a human-readable message alongside the code', async () => {
    const response = await dispatch({ id: '1', type: 'NOPE' }, context());
    expect(response.error?.message).toBe('Message interne invalide.');
  });
});

describe('withinResponseLimit', () => {
  it('passes a normal response through untouched', () => {
    const response: NativeResponse = { id: '1', success: true, data: { ok: true } };
    expect(withinResponseLimit(response)).toBe(response);
  });

  it('replaces a response over the Chrome cap with one that explains why', () => {
    // Chrome drops an oversized host message with no error anywhere, so the
    // extension would just hang waiting.
    const response: NativeResponse = {
      id: '1',
      success: true,
      data: { pad: 'x'.repeat(MAX_RESPONSE_BYTES) },
    };
    const guarded = withinResponseLimit(response);
    expect(guarded.success).toBe(false);
    expect(guarded.id).toBe('1');
    expect(guarded.error?.detail).toContain('au-delà de la limite');
  });

  it('measures bytes rather than characters', () => {
    const half = Math.floor(MAX_RESPONSE_BYTES / 2);
    // Two-byte characters: under the cap by length, over it by bytes.
    const response: NativeResponse = { id: '1', success: true, data: { pad: 'é'.repeat(half) } };
    expect(withinResponseLimit(response).success).toBe(false);
  });
});
