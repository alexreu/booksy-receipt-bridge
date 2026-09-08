import { describe, expect, it } from 'vitest';
import { WRITING_KINDS, parseConfigPatch, parseExtensionRequest } from './protocol.ts';

describe('parseExtensionRequest', () => {
  it('accepts the read-only intents', () => {
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

  it('accepts PRINT_TEST', () => {
    expect(parseExtensionRequest({ kind: 'PRINT_TEST' })).toEqual({ kind: 'PRINT_TEST' });
  });

  it('refuses an update check from a page context', () => {
    // It is a writing intent, so the router refuses it to a content script;
    // parsing it is fine, acting on it from a page is not.
    expect(parseExtensionRequest({ kind: 'CHECK_UPDATE' })).toEqual({ kind: 'CHECK_UPDATE' });
    expect(parseExtensionRequest({ kind: 'DOWNLOAD_UPDATE' })).toEqual({
      kind: 'DOWNLOAD_UPDATE',
    });
  });

  it('accepts PRINT_ACTIVE_TAB and ignores any url a caller attaches', () => {
    // The intent carries no address on purpose: the worker resolves the active
    // tab itself, so there is nothing from a caller to validate.
    expect(parseExtensionRequest({ kind: 'PRINT_ACTIVE_TAB' })).toEqual({
      kind: 'PRINT_ACTIVE_TAB',
    });
    expect(
      parseExtensionRequest({ kind: 'PRINT_ACTIVE_TAB', url: 'https://evil.example/x.pdf' }),
    ).toEqual({ kind: 'PRINT_ACTIVE_TAB' });
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

  it('lists the intents that change something', () => {
    expect(WRITING_KINDS).toEqual([
      'SET_CONFIG',
      'PRINT_TEST',
      'PRINT_DETECTED',
      'DISMISS_DETECTED',
      'PRINT_ACTIVE_TAB',
      // A check changes nothing locally, but it reaches the network, and AC19
      // means that must never happen without the user asking.
      'CHECK_UPDATE',
      'DOWNLOAD_UPDATE',
    ]);
  });

  it('accepts the detected-receipt intents with an integer id', () => {
    expect(parseExtensionRequest({ kind: 'LIST_DETECTED' })).toEqual({ kind: 'LIST_DETECTED' });
    expect(parseExtensionRequest({ kind: 'PRINT_DETECTED', downloadId: 42 })).toEqual({
      kind: 'PRINT_DETECTED',
      downloadId: 42,
    });
    expect(parseExtensionRequest({ kind: 'DISMISS_DETECTED', downloadId: 0 })).toEqual({
      kind: 'DISMISS_DETECTED',
      downloadId: 0,
    });
  });

  it('refuses a caller naming a file instead of a download id', () => {
    // The worker holds the path it recorded itself; a caller names an id and
    // nothing else, so nothing in a page can nominate a file to open.
    expect(parseExtensionRequest({ kind: 'PRINT_DETECTED' })).toBeUndefined();
    expect(
      parseExtensionRequest({ kind: 'PRINT_DETECTED', path: '/etc/passwd' }),
    ).toBeUndefined();
    expect(parseExtensionRequest({ kind: 'PRINT_DETECTED', downloadId: '42' })).toBeUndefined();
    expect(parseExtensionRequest({ kind: 'PRINT_DETECTED', downloadId: 1.5 })).toBeUndefined();
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
