/**
 * The DOM globals pdf.js insists on existing, even to read text.
 *
 * WHY THIS IS NEEDED AT ALL. pdf.js's legacy build touches `DOMMatrix`,
 * `ImageData` and `Path2D` while its module initialises. Running from
 * node_modules it finds them through an optional `@napi-rs/canvas` dependency,
 * or degrades with a warning. Bundled into a single executable that dynamic
 * lookup cannot resolve, and the module throws `DOMMatrix is not defined`
 * before a single page is read - which is exactly how the built host failed.
 *
 * WHY STUBS ARE HONEST HERE. These types exist for RENDERING. This project only
 * ever asks pdf.js for positioned text, so nothing calls a method on them. They
 * are deliberately inert: if some future code path did try to rasterise a page,
 * it should fail loudly rather than silently draw nothing.
 *
 * Only ever fills a gap - anything already defined is left alone, so running
 * from node_modules behaves exactly as before.
 */

const RENDERING_ONLY = 'Booksy Receipt Bridge ne fait pas de rendu PDF, seulement de la lecture de texte.';

function inertClass(name: string): new (...args: unknown[]) => object {
  return class {
    constructor() {
      // Constructing one is harmless; pdf.js does so while probing.
      Object.defineProperty(this, '__brbStub', { value: name, enumerable: false });
    }

    // Any actual use is a bug in this project, not a condition to absorb.
    toString(): string {
      throw new Error(`${name} : ${RENDERING_ONLY}`);
    }
  };
}

const REQUIRED = ['DOMMatrix', 'ImageData', 'Path2D'] as const;

/** Names that were missing and had to be filled in. */
export function ensurePdfjsGlobals(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): string[] {
  const added: string[] = [];
  for (const name of REQUIRED) {
    if (target[name] === undefined) {
      target[name] = inertClass(name);
      added.push(name);
    }
  }
  return added;
}
