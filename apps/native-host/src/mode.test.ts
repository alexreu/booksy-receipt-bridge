import { describe, expect, it } from 'vitest';
import { CLI_COMMANDS, selectMode } from './mode.ts';

describe('selectMode', () => {
  it('serves the protocol when launched with no arguments', () => {
    expect(selectMode([])).toBe('messaging');
  });

  it('serves the protocol when a browser passes the calling origin', () => {
    // Regression. Chrome launches the host with the extension's origin as
    // argv[0]; treating it as a command made the host exit 2 and the extension
    // reported "Native host has exited". Reproduced only by loading the
    // extension in a real browser.
    expect(selectMode(['chrome-extension://ndfcmfgnelpdjgpmaelpdgoccmjcpdjm/'])).toBe('messaging');
    expect(selectMode(['moz-extension://abc/'])).toBe('messaging');
  });

  it('serves the protocol for the Windows parent-window switch', () => {
    expect(selectMode(['--parent-window=0'])).toBe('messaging');
    expect(selectMode(['chrome-extension://abc/', '--parent-window=12345'])).toBe('messaging');
  });

  it('serves the protocol for an unfamiliar switch rather than dying on it', () => {
    // Guessing wrong on an unknown browser flag kills the host; guessing wrong
    // on a mistyped command only prints usage.
    expect(selectMode(['--some-future-chrome-flag=1'])).toBe('messaging');
  });

  it('runs the CLI for every documented command', () => {
    for (const command of CLI_COMMANDS) {
      expect(selectMode([command])).toBe('cli');
    }
  });

  it('keeps the CLI usable after the command word', () => {
    expect(selectMode(['ticket', 'fixtures/booksy/x.pdf'])).toBe('cli');
    expect(selectMode(['config', 'set', 'printer.name', 'X'])).toBe('cli');
  });

  it('shows usage for something that looks like a mistyped command', () => {
    expect(selectMode(['tickett'])).toBe('usage');
    expect(selectMode(['imprime'])).toBe('usage');
  });
});

describe('selectMode - the update command', () => {
  it('runs the CLI for it, like every other command', () => {
    expect(selectMode(['update'])).toBe('cli');
    expect(selectMode(['update', '--download'])).toBe('cli');
  });
});
