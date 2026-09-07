import { describe, expect, it } from 'vitest';
import { WRITING_KINDS, parseConfigPatch, parseExtensionRequest } from './protocol.ts';

describe('parseExtensionRequest', () => {
  it('accepts the read-only intents', () => {
    for (const kind of ['GET_HOST_STATE', 'PING_HOST', 'LIST_PRINTERS', 'GET_CONFIG'] as const) {
      expect(parseExtensionRequest({ kind })).toEqual({ kind });
    }
  });

  it('accepts PRINT_TEST', () => {
    expect(parseExtensionRequest({ kind: 'PRINT_TEST' })).toEqual({ kind: 'PRINT_TEST' });
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
    expect(WRITING_KINDS).toEqual(['SET_CONFIG', 'PRINT_TEST']);
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
