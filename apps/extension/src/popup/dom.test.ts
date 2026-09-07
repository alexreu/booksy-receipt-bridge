// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type StatusData } from '@brb/shared';
import { applyPopupView } from './dom.ts';
import { popupView } from './render.ts';

/**
 * The REAL popup markup, not a hand-written stand-in.
 *
 * This is what makes the test worth having: it fails if an id is renamed in
 * either file, which in a browser shows up as an empty popup and nothing else.
 */
// Resolved from the repo root rather than import.meta.url: under the jsdom
// environment import.meta.url is not a file: URL.
const MARKUP = readFileSync(
  join(process.cwd(), 'apps/extension/src/popup/index.html'),
  'utf8',
);

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
    supported: ['PING', 'GET_STATUS', 'PRINT_TEST'],
    ...overrides,
  };
}

beforeEach(() => {
  document.documentElement.innerHTML = MARKUP;
});

function text(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? '';
}

describe('applyPopupView - the markup has every hook the code uses', () => {
  it('renders each state without a missing-element error', () => {
    const states = [
      { kind: 'checking' } as const,
      {
        kind: 'unavailable' as const,
        error: { code: 'NATIVE_HOST_NOT_FOUND' as const, message: 'pas installé' },
      },
      { kind: 'version-mismatch' as const, hostVersion: '0.1', hostProtocol: 2, expected: 1 },
      { kind: 'connected' as const, version: '1.4.0', status: status() },
    ];
    for (const state of states) {
      expect(() => applyPopupView(document, popupView(state))).not.toThrow();
    }
  });
});

describe('applyPopupView - connected and ready', () => {
  beforeEach(() => {
    applyPopupView(document, popupView({ kind: 'connected', version: '1.4.0', status: status() }));
  });

  it('shows the connected summary and tags the state for styling', () => {
    expect(text('#summary')).toBe('Service connecté');
    expect(document.getElementById('summary')?.dataset['state']).toBe('connected');
  });

  it('shows the printer name', () => {
    expect(document.getElementById('printer')?.hidden).toBe(false);
    expect(text('#printer-name')).toBe('EPSON TM-T88V Receipt5');
  });

  it('renders one checklist row per item, all ticked', () => {
    const rows = [...document.querySelectorAll('#checklist li')];
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => (row as HTMLElement).dataset['ok'] === 'true')).toBe(true);
    expect(rows.map((row) => row.querySelector('.mark')?.textContent)).toEqual([
      '✓',
      '✓',
      '✓',
      '✓',
    ]);
  });

  it('enables the test print', () => {
    const button = document.getElementById('print-test') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('');
  });

  it('shows the versions and driver in the footer', () => {
    expect(text('#footer')).toContain('1.4.0');
    expect(text('#footer')).toContain('windows');
  });
});

describe('applyPopupView - connected but incomplete', () => {
  beforeEach(() => {
    applyPopupView(
      document,
      popupView({
        kind: 'connected',
        version: '0.1.0',
        status: status({
          printerFound: false,
          printerAdapter: 'mock',
          supported: ['PING', 'GET_STATUS'],
        }),
      }),
    );
  });

  it('marks the failed rows without failing the whole popup', () => {
    const rows = [...document.querySelectorAll('#checklist li')] as HTMLElement[];
    expect(rows.filter((row) => row.dataset['ok'] === 'false')).toHaveLength(1);
    expect(rows.some((row) => row.textContent?.includes('mock'))).toBe(true);
  });

  it('disables the test print and explains why in the tooltip', () => {
    const button = document.getElementById('print-test') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('pas encore disponible');
  });
});

describe('applyPopupView - unavailable', () => {
  beforeEach(() => {
    applyPopupView(
      document,
      popupView({
        kind: 'unavailable',
        error: {
          code: 'NATIVE_HOST_NOT_FOUND',
          message: "Booksy Receipt Bridge n'est pas installé sur ce PC.",
          detail: 'Specified native messaging host not found.',
        },
      }),
    );
  });

  it('shows the message, the fix and the raw detail', () => {
    expect(text('#summary')).toContain("n'est pas installé");
    expect(text('#hint')).toContain('Installez');
    expect(text('#footer')).toBe('Specified native messaging host not found.');
  });

  it('hides the printer section rather than showing a dash', () => {
    expect(document.getElementById('printer')?.hidden).toBe(true);
  });

  it('leaves the test print disabled', () => {
    expect((document.getElementById('print-test') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('applyPopupView - re-render', () => {
  it('replaces the previous checklist instead of appending to it', () => {
    const connected = popupView({ kind: 'connected', version: '1.4.0', status: status() });
    applyPopupView(document, connected);
    applyPopupView(document, connected);
    expect(document.querySelectorAll('#checklist li')).toHaveLength(4);
  });

  it('clears the hint when a later state has none', () => {
    applyPopupView(
      document,
      popupView({
        kind: 'unavailable',
        error: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
      }),
    );
    expect(text('#hint')).not.toBe('');

    applyPopupView(document, popupView({ kind: 'connected', version: '1.4.0', status: status() }));
    expect(text('#hint')).toBe('');
  });
});
