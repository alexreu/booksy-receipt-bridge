import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMockPrinterAdapter, type PrinterAdapter } from '@brb/printer';
import {
  fixedClock,
  MAX_RESPONSE_BYTES,
  NATIVE_MESSAGE_TYPES,
  type ListPrintersData,
  type NativeResponse,
  type StatusData,
} from '@brb/shared';
import { DEFAULT_CONFIG, type ConfigState } from '../config/config.ts';
import { silentLogger } from '../logging/logger.ts';
import { SUPPORTED, dispatch, withinResponseLimit, type HostContext } from './dispatch.ts';

const PRINTER_NAME = 'EPSON TM-T88V Receipt5';

function context(overrides: Partial<HostContext> = {}): HostContext {
  const dir = mkdtempSync(join(tmpdir(), 'brb-dispatch-'));
  return {
    version: '9.9.9',
    config: { config: DEFAULT_CONFIG, present: false } satisfies ConfigState,
    printer: createMockPrinterAdapter(),
    printerAdapter: 'mock',
    log: silentLogger(),
    configFile: join(dir, 'config.json'),
    historyPath: join(dir, 'print-history.json'),
    clock: fixedClock(1_700_000_000_000),
    updateDir: join(dir, 'updates'),
    // No test reaches the network: an unexpected call is a failure, not a
    // silent HTTP request.
    fetch: () => Promise.reject(new Error('fetch inattendu dans un test')),
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
      printer: createMockPrinterAdapter({ printers: [{ name: PRINTER_NAME }] }),
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
      printer: createMockPrinterAdapter({ printers: [{ name: 'Autre imprimante' }] }),
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
    expect(status.supported).toEqual(SUPPORTED);
  });

  it('implements every type the protocol declares', async () => {
    // The invariant that matters now the protocol is complete: a type added to
    // the schema without a handler fails here rather than reaching a user as a
    // NOT_IMPLEMENTED error.
    expect([...SUPPORTED].sort()).toEqual([...NATIVE_MESSAGE_TYPES].sort());
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

  it('refuses to print with no printer configured, rather than failing obscurely', async () => {
    const response = await dispatch(
      {
        id: '1',
        type: 'PRINT_RECEIPT',
        payload: { source: { kind: 'path', path: '/tmp/x.pdf' } },
      },
      context(),
    );
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('PRINTER_NOT_FOUND');
  });

  it('refuses a path outside the allowed directories - plan section 23', async () => {
    const response = await dispatch(
      {
        id: '1',
        type: 'PARSE_RECEIPT',
        payload: { source: { kind: 'path', path: '/etc/passwd' } },
      },
      context(),
    );
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('FILE_NOT_ALLOWED');
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

describe('dispatch - LIST_PRINTERS', () => {
  it('returns the queues and names the implementation that answered', async () => {
    const response = await dispatch(
      { id: '1', type: 'LIST_PRINTERS' },
      context({ printer: createMockPrinterAdapter({ printers: [{ name: 'A' }, { name: 'B' }] }) }),
    );
    expect(response.success).toBe(true);
    const data = response.data as ListPrintersData;
    expect(data.printers.map((printer) => printer.name)).toEqual(['A', 'B']);
    expect(data.adapter).toBe('mock');
  });
});

describe('dispatch - configuration', () => {
  it('reports the configuration and whether a file exists', async () => {
    const response = await dispatch({ id: '1', type: 'GET_CONFIG' }, context());
    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({ present: false });
  });

  it('writes a patch and reports back what is now on disk', async () => {
    const ctx = context();
    const response = await dispatch(
      {
        id: '1',
        type: 'SET_CONFIG',
        payload: { printer: { name: PRINTER_NAME }, printing: { showPreview: false } },
      },
      ctx,
    );
    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      present: true,
      config: {
        printer: { name: PRINTER_NAME },
        printing: { showPreview: false, autoPrint: false },
      },
    });
  });

  it('makes the new configuration visible to the next message', async () => {
    // Re-read from disk rather than trusting the merge, so a later GET_STATUS
    // cannot disagree with what was just saved.
    const ctx = context();
    await dispatch(
      { id: '1', type: 'SET_CONFIG', payload: { printer: { name: PRINTER_NAME } } },
      ctx,
    );
    const status = await dispatch({ id: '2', type: 'GET_STATUS' }, ctx);
    expect((status.data as StatusData).printerName).toBe(PRINTER_NAME);
    expect((status.data as StatusData).configPresent).toBe(true);
  });

  it('rejects a patch that would store an invalid value', async () => {
    const response = await dispatch(
      { id: '1', type: 'SET_CONFIG', payload: { printing: { confidenceThreshold: 9 } } },
      context(),
    );
    expect(response.success).toBe(false);
  });
});
