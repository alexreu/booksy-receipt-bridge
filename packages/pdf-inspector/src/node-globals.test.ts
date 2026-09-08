import { describe, expect, it } from 'vitest';
import { ensurePdfjsGlobals } from './node-globals.ts';

describe('ensurePdfjsGlobals', () => {
  it('fills in the names pdf.js reads while it initialises', () => {
    // Bundled into a single executable, pdf.js threw "DOMMatrix is not
    // defined" before a single page was read.
    const target: Record<string, unknown> = {};
    expect(ensurePdfjsGlobals(target).sort()).toEqual(['DOMMatrix', 'ImageData', 'Path2D']);
    expect(typeof target['DOMMatrix']).toBe('function');
  });

  it('leaves anything already defined alone', () => {
    // Running from node_modules must behave exactly as before.
    const real = class Real {};
    const target: Record<string, unknown> = { DOMMatrix: real, ImageData: real, Path2D: real };
    expect(ensurePdfjsGlobals(target)).toEqual([]);
    expect(target['DOMMatrix']).toBe(real);
  });

  it('can be called twice without replacing what it added', () => {
    const target: Record<string, unknown> = {};
    ensurePdfjsGlobals(target);
    const first = target['DOMMatrix'];
    expect(ensurePdfjsGlobals(target)).toEqual([]);
    expect(target['DOMMatrix']).toBe(first);
  });

  it('constructs without complaint, since pdf.js probes them', () => {
    const target: Record<string, unknown> = {};
    ensurePdfjsGlobals(target);
    const Stub = target['DOMMatrix'] as new () => object;
    expect(() => new Stub()).not.toThrow();
  });

  it('fails loudly if anything actually tries to render', () => {
    // Inert on purpose: a rendering path reaching these is a bug here, not a
    // condition to absorb quietly.
    const target: Record<string, unknown> = {};
    ensurePdfjsGlobals(target);
    const Stub = target['Path2D'] as new () => { toString(): string };
    expect(() => new Stub().toString()).toThrow(/rendu PDF/);
  });
});
