import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type StatusData } from '@brb/shared';
import type { HostState } from '../messaging/state.ts';
import { popupView } from './render.ts';

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

function connected(overrides: Partial<StatusData> = {}): HostState {
  return { kind: 'connected', version: '1.2.3', status: statusData(overrides) };
}

describe('popupView - connected', () => {
  it('says the service is connected', () => {
    const view = popupView(connected());
    expect(view.summary).toBe('Service connecté');
    expect(view.state).toBe('connected');
  });

  it('shows the versions and the driver in the footer', () => {
    const view = popupView(connected());
    expect(view.footer).toContain('1.2.3');
    expect(view.footer).toContain('windows');
  });

  it('says where to choose a printer when none is configured', () => {
    // Not a blocker any more: the preview is where a printer is picked, and
    // this only points at it.
    const view = popupView(
      connected({ printerConfigured: false, printerFound: false, printerName: undefined }),
    );
    expect(view.hint).toContain('aperçu');
  });
});

describe('popupView - unavailable', () => {
  it('tells the user to install the service when it is not found', () => {
    const view = popupView({
      kind: 'unavailable',
      error: {
        code: 'NATIVE_HOST_NOT_FOUND',
        message: "Booksy Receipt Bridge n'est pas installé sur ce PC.",
        detail: 'Specified native messaging host not found.',
      },
    });
    expect(view.summary).toContain("n'est pas installé");
    expect(view.hint).toContain('Installez');
    expect(view.footer).toBe('Specified native messaging host not found.');
  });

  it('tells the user to re-register when the host refuses this extension', () => {
    // Not "install it": the service is present, its manifest just does not
    // list this extension's id.
    const view = popupView({
      kind: 'unavailable',
      error: { code: 'NATIVE_HOST_FORBIDDEN', message: 'refusé' },
    });
    expect(view.hint).toContain('réenregistré');
  });

  it('points at the logs when the host crashed', () => {
    const view = popupView({
      kind: 'unavailable',
      error: { code: 'NATIVE_HOST_CRASHED', message: 'arrêté' },
    });
    expect(view.hint).toContain('journaux');
  });

  it('collapses the checklist to the one thing that failed', () => {
    const view = popupView({
      kind: 'unavailable',
      error: { code: 'NATIVE_HOST_NOT_FOUND', message: 'pas installé' },
    });
    expect(view.checklist).toHaveLength(1);
    expect(view.checklist[0]?.ok).toBe(false);
  });
});

describe('popupView - other states', () => {
  it('asks the user to update on a protocol mismatch', () => {
    const view = popupView({
      kind: 'version-mismatch',
      hostVersion: '0.0.1',
      hostProtocol: 2,
      expected: 1,
    });
    expect(view.summary).toContain('protocole 2');
    expect(view.hint).toContain('Mettez à jour');
  });

  it('renders a checking state without promising anything', () => {
    const view = popupView({ kind: 'checking' });
    expect(view.summary).toContain('Vérification');
    expect(view.hint).toBeUndefined();
  });
});
