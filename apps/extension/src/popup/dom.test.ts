// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type StatusData } from '@brb/shared';
import { applyActiveTabPdf, applyPopupView, applyUpdateView } from './dom.ts';
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

});

describe('applyPopupView - the feedback element is left alone', () => {
  it('does not clear a message about an action the user just took', () => {
    // Regression: the test-print result used to share #hint, and the re-render
    // that follows a print wiped it, so clicking the button reported nothing.
    const feedback = document.getElementById('feedback');
    expect(feedback).not.toBeNull();
    if (feedback === null) return;

    feedback.textContent = 'Ticket de test envoyé.';
    applyPopupView(document, popupView({ kind: 'connected', version: '1.4.0', status: status() }));
    expect(feedback.textContent).toBe('Ticket de test envoyé.');
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

describe('applyActiveTabPdf', () => {
  const PDF = { name: 'recu-1167.pdf', url: 'https://booksy.com/recu/1167.pdf' };

  it('keeps the print button in sight even with no PDF, and says why', () => {
    // Hiding it left the popup showing only "Imprimer un test", which reads as
    // if printing a receipt were not what this extension does.
    applyActiveTabPdf(document, null, true);
    const section = document.getElementById('tab-pdf');
    const button = document.getElementById('print-tab') as HTMLButtonElement;
    expect(section?.hidden).toBe(false);
    expect(section?.textContent).toContain('Ouvrez le reçu PDF');
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('PDF');
  });

  it('labels the action Imprimer, not Imprimer un test', () => {
    // The two were confusable in the popup, and only one of them prints the
    // receipt the user is looking at.
    const print = document.getElementById('print-tab') as HTMLButtonElement;
    expect(print.textContent).toContain('Imprimer');
    expect(print.textContent).not.toContain('test');
  });

  it('names the document so the user sees which one is meant', () => {
    applyActiveTabPdf(document, PDF, true);
    expect(document.getElementById('tab-pdf')?.hidden).toBe(false);
    expect(document.getElementById('tab-pdf-name')?.textContent).toBe('recu-1167.pdf');
    expect((document.getElementById('print-tab') as HTMLButtonElement).disabled).toBe(false);
  });

  it('greys the button with a reason when the service is down', () => {
    // The only thing that can stop it now: the printer itself is chosen in the
    // preview, so a poste with no default printer can still print.
    applyActiveTabPdf(document, PDF, false);
    const button = document.getElementById('print-tab') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('service');
  });

  it('shows the URL nowhere, only the name', () => {
    applyActiveTabPdf(document, PDF, true);
    expect(document.getElementById('tab-pdf')?.textContent).not.toContain('https://');
  });

  it('is not blanked by a host state re-render', () => {
    applyActiveTabPdf(document, PDF, true);
    applyPopupView(document, popupView({ kind: 'connected', version: '1.4.0', status: status() }));
    expect(document.getElementById('tab-pdf')?.hidden).toBe(false);
  });

  it('names the one action that helps when the tab cannot be read', () => {
    // Worded without blaming the user: telling someone who just clicked the
    // toolbar icon to click the toolbar icon is worse than saying nothing.
    // Reloading the page is what re-establishes the grant.
    applyActiveTabPdf(document, null, true, 'no-permission');
    const section = document.getElementById('tab-pdf');
    expect(section?.hidden).toBe(false);
    expect(section?.textContent).toContain('Rechargez');
    expect(section?.textContent).not.toContain('icône');
    expect((document.getElementById('print-tab') as HTMLButtonElement).disabled).toBe(true);
  });

  it('greys the button for a tab that simply is not a PDF', () => {
    applyActiveTabPdf(document, null, true, 'not-a-pdf');
    const button = document.getElementById('print-tab') as HTMLButtonElement;
    expect(document.getElementById('tab-pdf')?.hidden).toBe(false);
    expect(button.disabled).toBe(true);
  });

  it('re-enables the button once a PDF is in the tab again', () => {
    // Regression: the disabled state and the message both have to be undone,
    // or the popup keeps saying to open a PDF over the name of the one open.
    applyActiveTabPdf(document, null, true, 'not-a-pdf');
    applyActiveTabPdf(document, PDF, true);
    const button = document.getElementById('print-tab') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('');
    expect(document.getElementById('tab-pdf-name')?.textContent).toBe('recu-1167.pdf');
  });
});

describe('applyUpdateView', () => {
  it('writes the summary and enables the download when there is one', () => {
    applyUpdateView(document, { summary: 'Version v0.2.0 disponible.', canDownload: true });
    expect(document.getElementById('update-summary')?.textContent).toContain('v0.2.0');
    expect((document.getElementById('download-update') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the download disabled when there is nothing to fetch', () => {
    applyUpdateView(document, { summary: 'À jour.', canDownload: false });
    expect((document.getElementById('download-update') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows and then clears the detail line', () => {
    applyUpdateView(document, { summary: 'x', canDownload: false, detail: 'jeton refusé' });
    expect(document.getElementById('update-detail')?.textContent).toBe('jeton refusé');
    applyUpdateView(document, { summary: 'y', canDownload: false });
    expect(document.getElementById('update-detail')?.textContent).toBe('');
  });

  it('starts unchecked, since nothing reaches the network unprompted', () => {
    expect(document.getElementById('update-summary')?.textContent).toBe('Non vérifiée.');
    expect((document.getElementById('download-update') as HTMLButtonElement).disabled).toBe(true);
  });
});
