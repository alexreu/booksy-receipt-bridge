import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, downloadUpdate, type UpdateDeps } from './github.ts';

const REPO = 'alexreu/booksy-receipt-bridge';
const ASSET_URL = `https://api.github.com/repos/${REPO}/releases/assets/1`;

let downloadDir: string;

function release(overrides: Record<string, unknown> = {}): unknown {
  return {
    tag_name: 'v0.2.0',
    html_url: `https://github.com/${REPO}/releases/tag/v0.2.0`,
    body: 'Corrige la coupe papier.',
    assets: [
      {
        name: 'BooksyReceiptBridge-0.2.0.zip',
        url: ASSET_URL,
        browser_download_url: 'https://example.invalid/x.zip',
        size: 1234,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deps(overrides: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    repo: REPO,
    currentVersion: '0.1.0',
    downloadDir,
    fetch: () => Promise.resolve(jsonResponse(release())),
    ...overrides,
  };
}

beforeEach(() => {
  downloadDir = mkdtempSync(join(tmpdir(), 'brb-update-'));
});

describe('checkForUpdate', () => {
  it('reports a newer release', async () => {
    const check = await checkForUpdate(deps());
    expect(check).toMatchObject({
      current: '0.1.0',
      latest: 'v0.2.0',
      available: true,
      assetName: 'BooksyReceiptBridge-0.2.0.zip',
      assetBytes: 1234,
    });
    expect(check.notes).toContain('coupe papier');
  });

  it('reports being up to date without calling it an error', async () => {
    const check = await checkForUpdate(deps({ currentVersion: '0.2.0' }));
    expect(check.available).toBe(false);
    expect(check.error).toBeUndefined();
  });

  it('never offers an older release', async () => {
    const check = await checkForUpdate(deps({ currentVersion: '1.0.0' }));
    expect(check.available).toBe(false);
  });

  it('ignores a draft release', async () => {
    const check = await checkForUpdate(
      deps({ fetch: () => Promise.resolve(jsonResponse(release({ draft: true }))) }),
    );
    expect(check.available).toBe(false);
  });

  it('flags a pre-release so the user can decide', async () => {
    const check = await checkForUpdate(
      deps({ fetch: () => Promise.resolve(jsonResponse(release({ prerelease: true }))) }),
    );
    expect(check.prerelease).toBe(true);
  });

  it('sends the token when there is one, and none when there is not', async () => {
    // A fresh Response per call: a body can only be read once.
    const fetch = vi
      .fn<UpdateDeps['fetch']>()
      .mockImplementation(() => Promise.resolve(jsonResponse(release())));

    await checkForUpdate(deps({ fetch, token: 'ghp_secret' }));
    expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer ghp_secret',
    );

    fetch.mockClear();
    await checkForUpdate(deps({ fetch }));
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
  });

  it('treats an empty token as no token', async () => {
    const fetch = vi
      .fn<UpdateDeps['fetch']>()
      .mockImplementation(() => Promise.resolve(jsonResponse(release())));
    await checkForUpdate(deps({ fetch, token: '' }));
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
  });

  it('explains a 404 differently depending on whether a token was used', async () => {
    // A private repository is indistinguishable from a missing one without
    // credentials, and that is the single most likely misconfiguration.
    const missing = (): Promise<Response> => Promise.resolve(jsonResponse({}, 404));

    const withoutToken = await checkForUpdate(deps({ fetch: missing }));
    expect(withoutToken.error).toContain('privé');

    const withToken = await checkForUpdate(deps({ fetch: missing, token: 'x' }));
    expect(withToken.error).toContain('jeton');
  });

  it('explains a refused token', async () => {
    const check = await checkForUpdate(
      deps({ fetch: () => Promise.resolve(jsonResponse({}, 401)), token: 'x' }),
    );
    expect(check.error).toContain('refusé');
  });

  it('survives the network being unavailable', async () => {
    const log = vi.fn();
    const check = await checkForUpdate(
      deps({ fetch: () => Promise.reject(new Error('ENOTFOUND')), log }),
    );
    expect(check).toMatchObject({ current: '0.1.0', available: false });
    expect(check.error).toContain('Réseau');
    expect(log).toHaveBeenCalled();
  });

  it('asks GitHub for the latest release of the configured repository', async () => {
    const fetch = vi
      .fn<UpdateDeps['fetch']>()
      .mockImplementation(() => Promise.resolve(jsonResponse(release())));
    await checkForUpdate(deps({ fetch, repo: 'autre/dépôt' }));
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/autre/dépôt/releases/latest',
    );
  });
});

describe('downloadUpdate', () => {
  function fetchWith(assetBody: Uint8Array): UpdateDeps['fetch'] {
    return (url) =>
      Promise.resolve(
        url === ASSET_URL
          ? new Response(assetBody, { status: 200 })
          : jsonResponse(release()),
      );
  }

  it('writes the asset and reports where it went', async () => {
    const body = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const result = await downloadUpdate(deps({ fetch: fetchWith(body) }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe('v0.2.0');
    expect(result.bytes).toBe(4);
    expect(readFileSync(result.path)).toEqual(Buffer.from(body));
    expect(result.path.endsWith('BooksyReceiptBridge-0.2.0.zip')).toBe(true);
  });

  it('asks for the asset through the API url, which is what a token works with', async () => {
    const fetch = vi
      .fn<UpdateDeps['fetch']>()
      .mockImplementation(fetchWith(new Uint8Array([1])));
    await downloadUpdate(deps({ fetch, token: 'ghp_secret' }));

    const assetCall = fetch.mock.calls.find((call) => call[0] === ASSET_URL);
    expect(assetCall).toBeDefined();
    const assetHeaders = assetCall?.[1]?.headers as Record<string, string>;
    expect(assetHeaders['Accept']).toBe('application/octet-stream');
    expect(assetHeaders['Authorization']).toBe('Bearer ghp_secret');
  });

  it('refuses when there is nothing newer', async () => {
    const result = await downloadUpdate(
      deps({ currentVersion: '0.2.0', fetch: fetchWith(new Uint8Array([1])) }),
    );
    expect(result).toEqual({ ok: false, error: 'Aucune mise à jour à télécharger.' });
  });

  it('reports a release published without an installer', async () => {
    const result = await downloadUpdate(
      deps({ fetch: () => Promise.resolve(jsonResponse(release({ assets: [] }))) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("fichier d'installation");
  });

  it('ignores an asset that is not an installer', async () => {
    const result = await downloadUpdate(
      deps({
        fetch: () =>
          Promise.resolve(
            jsonResponse(
              release({ assets: [{ name: 'notes.txt', url: ASSET_URL, browser_download_url: '', size: 1 }] }),
            ),
          ),
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('passes the check failure through rather than trying to download', async () => {
    const result = await downloadUpdate(
      deps({ fetch: () => Promise.resolve(jsonResponse({}, 404)) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('privé');
  });

});
