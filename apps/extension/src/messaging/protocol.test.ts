import { describe, expect, it } from 'vitest';
import { PAGE_ALLOWED_KINDS, parseConfigPatch, parseExtensionRequest } from './protocol.ts';

describe('parseExtensionRequest', () => {
  it('accepts the allowlisted intents', () => {
    for (const kind of [
      'GET_HOST_STATE',
      'GET_ACTIVE_TAB',
      'PING_HOST',
      'LIST_PRINTERS',
      'GET_CONFIG',
    ] as const) {
      expect(parseExtensionRequest({ kind })).toEqual({ kind });
    }
  });

  it('accepts a preview source by kind, never by path', () => {
    // The only source there is: the worker reads the active tab itself.
    expect(parseExtensionRequest({ kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } })).toEqual(
      { kind: 'PREPARE_PREVIEW', source: { kind: 'activeTab' } },
    );
  });

  it('refuses a preview source that names a file', () => {
    for (const source of [
      { kind: 'path', path: '/etc/passwd' },
      { kind: 'download', downloadId: 7 },
      { kind: 'bytes', base64: 'JVBERi0=' },
      [],
      null,
      'activeTab',
    ]) {
      expect(parseExtensionRequest({ kind: 'PREPARE_PREVIEW', source }), JSON.stringify(source))
        .toBeUndefined();
    }
    expect(parseExtensionRequest({ kind: 'PREPARE_PREVIEW' })).toBeUndefined();
  });

  it('accepts the preview intents that carry an id', () => {
    expect(parseExtensionRequest({ kind: 'RENDER_PREVIEW', id: 'p-1' })).toEqual({
      kind: 'RENDER_PREVIEW',
      id: 'p-1',
    });
    expect(
      parseExtensionRequest({ kind: 'PRINT_PREVIEW', id: 'p-1', printerName: 'X' }),
    ).toEqual({ kind: 'PRINT_PREVIEW', id: 'p-1', printerName: 'X' });
    expect(parseExtensionRequest({ kind: 'DISCARD_PREVIEW', id: 'p-1' })).toEqual({
      kind: 'DISCARD_PREVIEW',
      id: 'p-1',
    });
  });

  it('refuses a preview intent with no id or a bad printer', () => {
    expect(parseExtensionRequest({ kind: 'RENDER_PREVIEW' })).toBeUndefined();
    expect(parseExtensionRequest({ kind: 'RENDER_PREVIEW', id: '' })).toBeUndefined();
    expect(parseExtensionRequest({ kind: 'PRINT_PREVIEW', id: 'p', printerName: 7 })).toBeUndefined();
  });

  it('ignores a column count a caller attaches', () => {
    // The paper is 80 mm and the width lives in the settings; a caller naming
    // its own would print a ticket nobody previewed at that width.
    expect(parseExtensionRequest({ kind: 'RENDER_PREVIEW', id: 'p-1', columns: 32 })).toEqual({
      kind: 'RENDER_PREVIEW',
      id: 'p-1',
    });
  });

  it('refuses an update check from a page context', () => {
    // It is a writing intent, so the router refuses it to a content script;
    // parsing it is fine, acting on it from a page is not.
    expect(parseExtensionRequest({ kind: 'CHECK_UPDATE' })).toEqual({ kind: 'CHECK_UPDATE' });
    expect(parseExtensionRequest({ kind: 'DOWNLOAD_UPDATE' })).toEqual({
      kind: 'DOWNLOAD_UPDATE',
    });
  });

  it('accepts SET_CONFIG with a valid patch', () => {
    expect(
      parseExtensionRequest({ kind: 'SET_CONFIG', patch: { printer: { name: 'A', columns: 42 } } }),
    ).toEqual({ kind: 'SET_CONFIG', patch: { printer: { name: 'A', columns: 42 } } });
  });

  it('refuses SET_CONFIG with no patch or a bad one', () => {
    expect(parseExtensionRequest({ kind: 'SET_CONFIG' })).toBeUndefined();
    expect(
      parseExtensionRequest({ kind: 'SET_CONFIG', patch: { printer: { columns: 'beaucoup' } } }),
    ).toBeUndefined();
  });

  it('refuses anything it does not recognise', () => {
    for (const raw of [
      null,
      undefined,
      'GET_CONFIG',
      42,
      [],
      {},
      { kind: 7 },
      { kind: 'RUN_ANYTHING' },
      { kind: 'PRINT_RECEIPT' },
    ]) {
      expect(parseExtensionRequest(raw)).toBeUndefined();
    }
  });

  it('does not relay a native message type named by the caller', () => {
    // The internal protocol is a closed set of intents, not a passthrough.
    expect(parseExtensionRequest({ kind: 'PARSE_RECEIPT' })).toBeUndefined();
    expect(parseExtensionRequest({ type: 'PRINT_RECEIPT', id: 'x' })).toBeUndefined();
  });

  it('allowlists what a page may send, rather than denylisting', () => {
    // Default-deny: an intent added later is refused to pages until listed.
    // These carry no argument and reveal nothing a page does not know.
    expect(PAGE_ALLOWED_KINDS).toEqual([
      'GET_HOST_STATE',
      'GET_ACTIVE_TAB',
      'PING_HOST',
      'LIST_PRINTERS',
      'GET_CONFIG',
    ]);
    for (const kind of ['SET_CONFIG', 'PREPARE_PREVIEW', 'PRINT_PREVIEW', 'RENDER_PREVIEW'] as const) {
      expect(PAGE_ALLOWED_KINDS).not.toContain(kind);
    }
  });

});

describe('parseConfigPatch', () => {
  it('accepts an empty patch', () => {
    expect(parseConfigPatch({})).toEqual({});
  });

  it('keeps only the keys it knows', () => {
    const patch = parseConfigPatch({
      printer: { name: 'A', paperWidth: 80, nonsense: 1 },
      printing: { autoPrint: true, alsoNonsense: 'x' },
      somethingElse: true,
    });
    expect(patch).toEqual({ printer: { name: 'A', paperWidth: 80 }, printing: { autoPrint: true } });
  });

  it('accepts a list of allowed directories', () => {
    expect(parseConfigPatch({ printing: { allowedDirs: ['/a', '/b'] } })).toEqual({
      printing: { allowedDirs: ['/a', '/b'] },
    });
  });

  it('refuses a wrong type rather than coercing it', () => {
    expect(parseConfigPatch({ printer: { name: 42 } })).toBeUndefined();
    expect(parseConfigPatch({ printer: { columns: '42' } })).toBeUndefined();
    expect(parseConfigPatch({ printing: { autoPrint: 'oui' } })).toBeUndefined();
    expect(parseConfigPatch({ printing: { allowedDirs: '/a' } })).toBeUndefined();
    expect(parseConfigPatch({ printing: { allowedDirs: [1, 2] } })).toBeUndefined();
  });

  it('refuses a non-finite number', () => {
    expect(parseConfigPatch({ printer: { paperWidth: Number.NaN } })).toBeUndefined();
    expect(parseConfigPatch({ printer: { paperWidth: Number.POSITIVE_INFINITY } })).toBeUndefined();
  });

  it('refuses a section that is not an object', () => {
    expect(parseConfigPatch({ printer: 'oui' })).toBeUndefined();
    expect(parseConfigPatch('nope')).toBeUndefined();
  });

  it('refuses an array where a section is expected', () => {
    // typeof [] === 'object', so a bare typeof check let this through and it
    // came out as an empty section instead of a refusal.
    expect(parseConfigPatch({ printing: [] })).toBeUndefined();
    expect(parseConfigPatch({ printer: ['name'] })).toBeUndefined();
    expect(parseConfigPatch([])).toBeUndefined();
  });
});
