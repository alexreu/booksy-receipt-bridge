import { describe, expect, it, vi } from 'vitest';
import type { NativeMessage, PingData } from '@brb/shared';
import {
  createChromeNativeHostClient,
  nextMessageId,
  transportError,
  type NativeHostClient,
  type SendNativeMessage,
} from './client.ts';
import { NATIVE_HOST_NAME } from './host-name.ts';

const PING: NativeMessage = { id: 'abc', type: 'PING' };

function clientWith(send: SendNativeMessage): NativeHostClient {
  return createChromeNativeHostClient(send);
}

describe('NATIVE_HOST_NAME', () => {
  it('is the name the installer registers, and must not change', () => {
    // The browser looks the host up under this string, and it goes into the
    // Windows registry. Changing it silently breaks every existing install.
    expect(NATIVE_HOST_NAME).toBe('com.alexdevlab.booksy_receipt_bridge');
  });
});

describe('createChromeNativeHostClient', () => {
  it('sends to the registered host name', async () => {
    const send = vi.fn<SendNativeMessage>().mockResolvedValue({ id: 'abc', success: true });
    await clientWith(send).send(PING);
    expect(send).toHaveBeenCalledWith(NATIVE_HOST_NAME, PING);
  });

  it('passes a successful response through', async () => {
    const data: PingData = { status: 'ready', version: '1.2.3', protocolVersion: 1 };
    const send = vi.fn<SendNativeMessage>().mockResolvedValue({ id: 'abc', success: true, data });
    await expect(clientWith(send).send<PingData>(PING)).resolves.toEqual({
      id: 'abc',
      success: true,
      data,
    });
  });

  it('passes an error response through', async () => {
    const error = { code: 'NOT_IMPLEMENTED', message: 'pas encore' };
    const send = vi.fn<SendNativeMessage>().mockResolvedValue({ id: 'abc', success: false, error });
    const response = await clientWith(send).send(PING);
    expect(response.success).toBe(false);
    expect(response.error).toEqual(error);
  });

  it('turns a thrown transport failure into a response, never a throw', async () => {
    // The caller then has one shape to handle: a host that is not installed and
    // a host that answered with an error are both "it did not succeed, here is
    // why", and the UI needs the same code path for both.
    const send = vi
      .fn<SendNativeMessage>()
      .mockRejectedValue(new Error('Specified native messaging host not found.'));
    const response = await clientWith(send).send(PING);
    expect(response).toMatchObject({
      id: 'abc',
      success: false,
      error: { code: 'NATIVE_HOST_NOT_FOUND' },
    });
  });

  it('refuses a reply that is not a response', async () => {
    for (const raw of [null, undefined, 'ok', 42, [], {}, { id: 'abc' }]) {
      const response = await clientWith(vi.fn<SendNativeMessage>().mockResolvedValue(raw)).send(
        PING,
      );
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('INVALID_MESSAGE');
    }
  });

  it('falls back to the request id when the reply omits one', async () => {
    const send = vi.fn<SendNativeMessage>().mockResolvedValue({ success: true, data: {} });
    const response = await clientWith(send).send(PING);
    expect(response.id).toBe('abc');
  });
});

describe('transportError', () => {
  it('recognises a missing host', () => {
    expect(transportError(new Error('Specified native messaging host not found.')).code).toBe(
      'NATIVE_HOST_NOT_FOUND',
    );
    expect(transportError(new Error('No such native application')).code).toBe(
      'NATIVE_HOST_NOT_FOUND',
    );
  });

  it('recognises a host that refuses this extension', () => {
    // A different fix from "install it": the service is there, its manifest
    // just does not list this extension's id.
    expect(transportError(new Error('Access to the specified native messaging host is forbidden.')).code).toBe(
      'NATIVE_HOST_FORBIDDEN',
    );
    expect(transportError(new Error('Native messaging host not allowed')).code).toBe(
      'NATIVE_HOST_FORBIDDEN',
    );
  });

  it('recognises a host that died', () => {
    expect(transportError(new Error('Native host has exited.')).code).toBe(
      'NATIVE_HOST_CRASHED',
    );
    expect(transportError(new Error('Native messaging port closed')).code).toBe(
      'NATIVE_HOST_CRASHED',
    );
  });

  it('treats anything unrecognised as not installed', () => {
    expect(transportError(new Error('quelque chose de nouveau')).code).toBe(
      'NATIVE_HOST_NOT_FOUND',
    );
  });

  it('always keeps the raw text, so a rephrased message stays diagnosable', () => {
    // Chrome gives these as plain English with no code; matching on the text is
    // the only option, so the original must survive the classification.
    const error = transportError(new Error('un libellé inédit de Chrome'));
    expect(error.detail).toBe('un libellé inédit de Chrome');
    expect(error.message).not.toBe('');
  });

  it('handles a thrown non-Error', () => {
    expect(transportError('boom').detail).toBe('boom');
  });
});

describe('nextMessageId', () => {
  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => nextMessageId()));
    expect(ids.size).toBe(500);
  });

  it('is built from a clock and a counter, not from randomness', () => {
    // So a test can pin the sequence. There is nothing to guess in a
    // correlation id; it only has to distinguish one in-flight reply.
    expect(nextMessageId()).toMatch(/^x-[0-9a-z]+-[0-9a-z]+$/);
  });
});
