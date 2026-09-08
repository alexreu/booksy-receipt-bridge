import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type BridgeConfig, type StatusData } from '@brb/shared';
import type { HostState } from '../messaging/state.ts';
import {
  AUTO_PRINT_IMPLEMENTED,
  buildPatch,
  formValuesOf,
  optionsView,
  type FormValues,
} from './view.ts';

function status(overrides: Partial<StatusData> = {}): StatusData {
  return {
    status: 'ready',
    version: '1.4.0',
    protocolVersion: PROTOCOL_VERSION,
    printerConfigured: true,
    printerName: 'EPSON TM-T88V Receipt5',
    printerFound: true,
    configPresent: true,
    printerAdapter: 'windows',
    supported: ['PING', 'GET_STATUS', 'LIST_PRINTERS', 'GET_CONFIG', 'SET_CONFIG', 'PRINT_TEST'],
    ...overrides,
  };
}

const CONNECTED: HostState = { kind: 'connected', version: '1.4.0', status: status() };
const OFFLINE: HostState = {
  kind: 'unavailable',
  error: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
};

const CONFIG: BridgeConfig = {
  printer: { name: 'EPSON TM-T88V Receipt5', paperWidth: 80, printableWidth: 72, columns: 42 },
  update: { repo: 'alexreu/booksy-receipt-bridge', token: '' },
  printing: { autoPrint: false, showPreview: true, confidenceThreshold: 0.9, allowedDirs: [] },
};

function values(overrides: Partial<FormValues> = {}): FormValues {
  return { ...formValuesOf(CONFIG), ...overrides };
}

describe('optionsView', () => {
  it('locks the form until the host answers', () => {
    // Editing settings that cannot be saved is worse than showing them greyed.
    expect(optionsView({ state: OFFLINE }).editable).toBe(false);
    expect(optionsView({ state: { kind: 'checking' } }).editable).toBe(false);
    expect(optionsView({ state: CONNECTED }).editable).toBe(true);
  });

  it('shows the host status verbatim', () => {
    expect(optionsView({ state: OFFLINE }).status).toBe('pas installé');
    expect(optionsView({ state: CONNECTED }).status).toBe('Service connecté');
  });

  it('says when the printer list comes from a mock', () => {
    const view = optionsView({
      state: CONNECTED,
      printers: [{ name: 'Mock Thermal 80mm' }],
      adapter: 'mock',
    });
    expect(view.printerNote).toContain('mock');
    expect(view.printerNote).toContain('pas de vraies imprimantes');
  });

  it('says nothing extra for a real Windows list', () => {
    const view = optionsView({
      state: CONNECTED,
      printers: [{ name: 'EPSON TM-T88V Receipt5' }],
      adapter: 'windows',
    });
    expect(view.printerNote).toBeUndefined();
  });

  it('says when no printer was detected at all', () => {
    const view = optionsView({ state: CONNECTED, printers: [], adapter: 'windows' });
    expect(view.printerNote).toContain('Aucune imprimante');
  });

  it('does not offer auto-print while the extension cannot act on it', () => {
    // The missing piece is in the extension - download detection and the
    // trigger - so the host being able to print a receipt is not enough. A
    // tickable box that does nothing is a promise the extension cannot keep.
    expect(AUTO_PRINT_IMPLEMENTED).toBe(false);
    const view = optionsView({
      state: {
        kind: 'connected',
        version: '1',
        status: status({ supported: ['PING', 'GET_STATUS', 'PRINT_RECEIPT'] }),
      },
      printers: [{ name: 'X' }],
    });
    expect(view.canAutoPrint).toBe(false);
    expect(view.autoPrintNote).toContain('téléchargements');
  });
});

describe('formValuesOf', () => {
  it('flattens the config into form fields', () => {
    expect(formValuesOf(CONFIG)).toEqual({
      printerName: 'EPSON TM-T88V Receipt5',
      paperWidth: 80,
      printableWidth: 72,
      columns: 42,
      showPreview: true,
      autoPrint: false,
      confidenceThreshold: 0.9,
    });
  });
});

describe('buildPatch', () => {
  it('builds a full patch from valid values', () => {
    const built = buildPatch(values());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.patch).toEqual({
      printer: {
        name: 'EPSON TM-T88V Receipt5',
        paperWidth: 80,
        printableWidth: 72,
        columns: 42,
      },
      printing: { showPreview: true, autoPrint: false, confidenceThreshold: 0.9 },
    });
  });

  it('allows clearing the printer', () => {
    const built = buildPatch(values({ printerName: '' }));
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.patch.printer?.name).toBe('');
  });

  it('refuses a printable width wider than the paper', () => {
    // Physically impossible, and it would silently clip every ticket.
    const built = buildPatch(values({ paperWidth: 58, printableWidth: 72 }));
    expect(built).toMatchObject({ ok: false });
    if (!built.ok) expect(built.message).toContain('dépasser');
  });

  it('refuses non-positive dimensions', () => {
    expect(buildPatch(values({ paperWidth: 0 })).ok).toBe(false);
    expect(buildPatch(values({ printableWidth: -1 })).ok).toBe(false);
  });

  it('refuses a fractional column count', () => {
    expect(buildPatch(values({ columns: 42.5 })).ok).toBe(false);
    expect(buildPatch(values({ columns: 0 })).ok).toBe(false);
  });

  it('refuses a threshold outside 0..1', () => {
    expect(buildPatch(values({ confidenceThreshold: 1.5 })).ok).toBe(false);
    expect(buildPatch(values({ confidenceThreshold: -0.1 })).ok).toBe(false);
    expect(buildPatch(values({ confidenceThreshold: 0 })).ok).toBe(true);
    expect(buildPatch(values({ confidenceThreshold: 1 })).ok).toBe(true);
  });

  it('refuses an empty numeric field, which reads as NaN', () => {
    // valueAsNumber on a blank input is NaN, so this is the common case.
    expect(buildPatch(values({ paperWidth: Number.NaN })).ok).toBe(false);
    expect(buildPatch(values({ confidenceThreshold: Number.NaN })).ok).toBe(false);
  });
});
