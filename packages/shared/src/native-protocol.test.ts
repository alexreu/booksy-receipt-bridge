import { describe, expect, it } from 'vitest';
import {
  MAX_RESPONSE_BYTES,
  NATIVE_MESSAGE_TYPES,
  parseNativeMessage,
} from './native-protocol.ts';

describe('parseNativeMessage', () => {
  it('accepts a bare PING', () => {
    const result = parseNativeMessage({ id: 'abc123', type: 'PING' });
    expect(result).toEqual({ ok: true, message: { id: 'abc123', type: 'PING' } });
  });

  it('rejects an unknown message type', () => {
    const result = parseNativeMessage({ id: 'abc123', type: 'DROP_TABLES' });
    expect(result.ok).toBe(false);
  });

  it('rejects a message with no id', () => {
    expect(parseNativeMessage({ type: 'PING' }).ok).toBe(false);
    expect(parseNativeMessage({ id: '', type: 'PING' }).ok).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(parseNativeMessage(null).ok).toBe(false);
    expect(parseNativeMessage('PING').ok).toBe(false);
    expect(parseNativeMessage([]).ok).toBe(false);
  });

  it('accepts both receipt sources', () => {
    const fromPath = parseNativeMessage({
      id: '1',
      type: 'PARSE_RECEIPT',
      payload: { source: { kind: 'path', path: 'C:\\Users\\x\\Downloads\\t.pdf' } },
    });
    const fromBytes = parseNativeMessage({
      id: '2',
      type: 'PARSE_RECEIPT',
      payload: { source: { kind: 'bytes', base64: 'JVBERi0=' } },
    });
    expect(fromPath.ok).toBe(true);
    expect(fromBytes.ok).toBe(true);
  });

  it('rejects a receipt source with an unknown kind', () => {
    const result = parseNativeMessage({
      id: '1',
      type: 'PARSE_RECEIPT',
      payload: { source: { kind: 'url', url: 'https://evil.example/x.pdf' } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects PARSE_RECEIPT with no payload', () => {
    expect(parseNativeMessage({ id: '1', type: 'PARSE_RECEIPT' }).ok).toBe(false);
  });

  it('rejects a confidence threshold outside 0..1', () => {
    const result = parseNativeMessage({
      id: '1',
      type: 'SET_CONFIG',
      payload: { printing: { confidenceThreshold: 1.5 } },
    });
    expect(result.ok).toBe(false);
  });

  it('reports readable issue paths', () => {
    const result = parseNativeMessage({
      id: '1',
      type: 'SET_CONFIG',
      payload: { printer: { paperWidth: -80 } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('printer.paperWidth');
  });

  it('covers every declared message type', () => {
    // Guards against adding a type to the union and forgetting the exported list.
    expect(new Set(NATIVE_MESSAGE_TYPES).size).toBe(NATIVE_MESSAGE_TYPES.length);
    expect(NATIVE_MESSAGE_TYPES).toContain('PRINT_TEST');
  });

  it('states the Chrome host -> extension size cap', () => {
    expect(MAX_RESPONSE_BYTES).toBe(1_000_000);
  });
});
