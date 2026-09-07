import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DATA_DIR_ENV, configPath, dataDir, logDir } from './paths.ts';

describe('dataDir', () => {
  it('honours the override, which is how tests avoid a real config', () => {
    expect(dataDir({ [DATA_DIR_ENV]: '/tmp/brb-test' })).toBe('/tmp/brb-test');
  });

  it('ignores an empty override', () => {
    expect(dataDir({ [DATA_DIR_ENV]: '' })).not.toBe('');
  });

  it('puts everything under one application folder', () => {
    const dir = dataDir({});
    expect(dir).toContain('BooksyReceiptBridge');
    expect(dir.startsWith(homedir())).toBe(true);
  });

  it('derives the config and log paths from it', () => {
    const override = { [DATA_DIR_ENV]: '/tmp/brb-test' };
    expect(configPath(override)).toBe('/tmp/brb-test/config.json');
    expect(logDir(override)).toBe('/tmp/brb-test/logs');
  });

  it('uses APPDATA on Windows', () => {
    // Plan section 38 puts the config in %APPDATA%\BooksyReceiptBridge, and the
    // installer registers the host under HKCU to avoid needing admin rights.
    if (process.platform !== 'win32') return;
    expect(dataDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })).toBe(
      'C:\\Users\\x\\AppData\\Roaming\\BooksyReceiptBridge',
    );
  });

  it('follows XDG_CONFIG_HOME on Linux', () => {
    if (process.platform !== 'linux') return;
    expect(dataDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/BooksyReceiptBridge');
  });
});
