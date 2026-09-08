import { describe, expect, it } from 'vitest';
import type { UpdateCheck } from '@brb/shared';
import { downloadedView, updateView } from './update.ts';

function check(overrides: Partial<UpdateCheck> = {}): UpdateCheck {
  return { current: '0.1.0', available: false, ...overrides };
}

describe('updateView', () => {
  it('says up to date when there is nothing newer', () => {
    const view = updateView(check());
    expect(view.summary).toContain('À jour');
    expect(view.summary).toContain('0.1.0');
    expect(view.canDownload).toBe(false);
  });

  it('names both versions when there is an update', () => {
    const view = updateView(
      check({ available: true, latest: 'v0.2.0', assetName: 'BooksyReceiptBridge-0.2.0.zip' }),
    );
    expect(view.summary).toContain('v0.2.0');
    expect(view.summary).toContain('0.1.0');
    expect(view.canDownload).toBe(true);
  });

  it('does not report a failed check as being up to date', () => {
    // The distinction that matters: conflating them would let a misconfigured
    // token look like reassurance.
    const view = updateView(check({ error: 'Le jeton a été refusé par GitHub.' }));
    expect(view.summary).toContain('impossible');
    expect(view.summary).not.toContain('À jour');
    expect(view.detail).toContain('jeton');
    expect(view.canDownload).toBe(false);
  });

  it('marks a pre-release so the user can decide', () => {
    const view = updateView(
      check({ available: true, latest: 'v0.2.0-beta.1', prerelease: true, assetName: 'x.zip' }),
    );
    expect(view.summary).toContain('pré-version');
  });

  it('refuses to offer a download when the release has no installer', () => {
    const view = updateView(check({ available: true, latest: 'v0.2.0' }));
    expect(view.canDownload).toBe(false);
    expect(view.detail).toContain('installation');
  });

  it('shows the first line of the release notes, not the whole changelog', () => {
    const view = updateView(
      check({
        available: true,
        latest: 'v0.2.0',
        assetName: 'x.zip',
        notes: 'Corrige la coupe papier.\n\n- détail un\n- détail deux',
      }),
    );
    expect(view.detail).toBe('Corrige la coupe papier.');
  });

  it('shows no detail when there are no notes', () => {
    const view = updateView(check({ available: true, latest: 'v0.2.0', assetName: 'x.zip' }));
    expect(view.detail).toBeUndefined();
  });
});

describe('downloadedView', () => {
  it('says where the installer went, since that is what the user needs next', () => {
    const message = downloadedView({
      ok: true,
      path: 'C:\\Users\\x\\AppData\\Roaming\\BooksyReceiptBridge\\updates\\brb-0.2.0.zip',
      bytes: 1234,
      version: 'v0.2.0',
    });
    expect(message).toContain('v0.2.0');
    expect(message).toContain('Install.ps1');
    expect(message).toContain('updates');
  });

  it('passes a failure through verbatim', () => {
    expect(downloadedView({ ok: false, error: 'Réseau indisponible.' })).toBe(
      'Réseau indisponible.',
    );
  });
});
