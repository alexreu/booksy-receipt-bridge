import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from './config.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brb-config-'));
  path = join(dir, 'config.json');
});

describe('DEFAULT_CONFIG', () => {
  it('describes 80 mm paper with a 72 mm printable width and 42 columns', () => {
    expect(DEFAULT_CONFIG.printer).toEqual({
      name: '',
      paperWidth: 80,
      printableWidth: 72,
      columns: 42,
    });
  });

  it('names no printer, so no model is baked in', () => {
    expect(DEFAULT_CONFIG.printer.name).toBe('');
  });

  it('leaves auto-print off and the threshold at 0.9', () => {
    expect(DEFAULT_CONFIG.printing).toEqual({
      autoPrint: false,
      showPreview: true,
      confidenceThreshold: 0.9,
    });
  });
});

describe('loadConfig', () => {
  it('reports a missing file without creating one', () => {
    const state = loadConfig(path);
    expect(state).toEqual({ config: DEFAULT_CONFIG, present: false });
    // Reading state must not write state.
    expect(() => readFileSync(path)).toThrow();
  });

  it('reads a stored config', () => {
    writeFileSync(
      path,
      JSON.stringify({
        printer: { name: 'EPSON TM-T88V Receipt5', paperWidth: 80, printableWidth: 72, columns: 42 },
        printing: { autoPrint: true, showPreview: false, confidenceThreshold: 0.95 },
      }),
    );
    const state = loadConfig(path);
    expect(state.present).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.config.printer.name).toBe('EPSON TM-T88V Receipt5');
    expect(state.config.printing.confidenceThreshold).toBe(0.95);
  });

  it('fills in a section the file omits', () => {
    writeFileSync(path, JSON.stringify({ printer: { name: 'X' } }));
    const state = loadConfig(path);
    expect(state.config.printer.name).toBe('X');
    expect(state.config.printer.columns).toBe(42);
    expect(state.config.printing).toEqual(DEFAULT_CONFIG.printing);
  });

  it('falls back to defaults on invalid JSON, and says so', () => {
    // Refusing to start because a file got truncated would strand the user with
    // no way to fix it from the UI.
    writeFileSync(path, '{ "printer": ');
    const state = loadConfig(path);
    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.present).toBe(true);
    expect(state.error).toContain('illisible');
  });

  it('falls back to defaults on a value out of range, and says which', () => {
    writeFileSync(path, JSON.stringify({ printing: { confidenceThreshold: 5 } }));
    const state = loadConfig(path);
    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.error).toContain('printing.confidenceThreshold');
  });

  it('falls back to defaults on a negative paper width', () => {
    writeFileSync(path, JSON.stringify({ printer: { paperWidth: -80 } }));
    expect(loadConfig(path).error).toContain('printer.paperWidth');
  });

  it('tolerates a file that is not an object', () => {
    writeFileSync(path, '"nope"');
    const state = loadConfig(path);
    expect(state.config).toEqual(DEFAULT_CONFIG);
    expect(state.present).toBe(true);
  });
});

describe('saveConfig', () => {
  it('creates the file and its directory', () => {
    const nested = join(dir, 'deeper', 'config.json');
    saveConfig(nested, { printer: { name: 'A' } });
    expect(loadConfig(nested).config.printer.name).toBe('A');
  });

  it('merges a patch instead of replacing the config', () => {
    saveConfig(path, { printer: { name: 'A', columns: 56 } });
    saveConfig(path, { printing: { autoPrint: true } });

    const { config } = loadConfig(path);
    expect(config.printer.name).toBe('A');
    expect(config.printer.columns).toBe(56);
    expect(config.printing.autoPrint).toBe(true);
    expect(config.printing.showPreview).toBe(true);
  });

  it('returns what it wrote', () => {
    const saved = saveConfig(path, { printer: { name: 'B' } });
    expect(saved).toEqual(loadConfig(path).config);
  });

  it('leaves no temporary file behind', () => {
    saveConfig(path, { printer: { name: 'C' } });
    expect(() => readFileSync(`${path}.tmp`)).toThrow();
  });

  it('rejects a patch that would store an invalid value', () => {
    expect(() => saveConfig(path, { printing: { confidenceThreshold: 2 } })).toThrow();
  });

  it('writes readable JSON', () => {
    saveConfig(path, { printer: { name: 'D' } });
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('\n  "printer"');
    expect(raw.endsWith('\n')).toBe(true);
  });
});
