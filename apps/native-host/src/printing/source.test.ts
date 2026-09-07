import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_RECEIPT_BYTES, isInside, resolveSource } from './source.ts';

const PDF = Buffer.from('%PDF-1.4\n% fake but well-signposted\n');

let root: string;
let downloads: string;
let elsewhere: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brb-source-'));
  downloads = join(root, 'Downloads');
  elsewhere = join(root, 'secrets');
  mkdirSync(downloads);
  mkdirSync(elsewhere);
});

function write(dir: string, name: string, content: Buffer = PDF): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('resolveSource - bytes', () => {
  it('accepts a PDF and hashes it', async () => {
    const result = await resolveSource({
      kind: 'bytes',
      base64: PDF.toString('base64'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.bytes)).toEqual(PDF);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses content that is not a PDF', async () => {
    const result = await resolveSource({
      kind: 'bytes',
      base64: Buffer.from('<html>bonjour</html>').toString('base64'),
    });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_RECEIPT' });
  });

  it('refuses empty content', async () => {
    expect(await resolveSource({ kind: 'bytes', base64: '' })).toMatchObject({
      ok: false,
      code: 'INVALID_RECEIPT',
    });
  });

  it('refuses content past the ceiling', async () => {
    const huge = Buffer.concat([PDF, Buffer.alloc(MAX_RECEIPT_BYTES)]);
    const result = await resolveSource({ kind: 'bytes', base64: huge.toString('base64') });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_RECEIPT' });
  });
});

describe('resolveSource - path, what is allowed', () => {
  it('accepts a PDF in the Downloads folder', async () => {
    const path = write(downloads, 'ticket-996.pdf');
    const result = await resolveSource({ kind: 'path', path }, { downloadsDir: downloads });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.origin).toContain('ticket-996.pdf');
  });

  it('accepts an extra configured directory', async () => {
    const path = write(elsewhere, 'recu.pdf');
    const result = await resolveSource(
      { kind: 'path', path },
      { downloadsDir: downloads, allowedDirs: [elsewhere] },
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a subdirectory of an allowed directory', async () => {
    const nested = join(downloads, 'booksy');
    mkdirSync(nested);
    const path = write(nested, 'recu.pdf');
    expect(
      (await resolveSource({ kind: 'path', path }, { downloadsDir: downloads })).ok,
    ).toBe(true);
  });

  it('accepts an uppercase extension', async () => {
    const path = write(downloads, 'RECU.PDF');
    expect((await resolveSource({ kind: 'path', path }, { downloadsDir: downloads })).ok).toBe(
      true,
    );
  });
});

describe('resolveSource - path, what is refused', () => {
  it('refuses a file outside every allowed directory', async () => {
    const path = write(elsewhere, 'recu.pdf');
    expect(await resolveSource({ kind: 'path', path }, { downloadsDir: downloads })).toMatchObject({
      ok: false,
      code: 'FILE_NOT_ALLOWED',
    });
  });

  it('refuses a symlink in Downloads that points outside it', async () => {
    // The attack this whole module exists for: every textual check passes, and
    // only resolving the link first catches it.
    const secret = write(elsewhere, 'id_rsa.pdf', Buffer.from('%PDF-1.4 pretend'));
    const link = join(downloads, 'innocent.pdf');
    symlinkSync(secret, link);

    expect(
      await resolveSource({ kind: 'path', path: link }, { downloadsDir: downloads }),
    ).toMatchObject({ ok: false, code: 'FILE_NOT_ALLOWED' });
  });

  it('refuses a traversal out of Downloads', async () => {
    write(elsewhere, 'recu.pdf');
    // Built by concatenation, not join(): join() normalises the ".." away, and
    // the literal segments are what a hostile caller would actually send.
    const traversal = `${downloads}/../secrets/recu.pdf`;
    expect(traversal).toContain('..');
    expect(
      await resolveSource({ kind: 'path', path: traversal }, { downloadsDir: downloads }),
    ).toMatchObject({ ok: false, code: 'FILE_NOT_ALLOWED' });
  });

  it('refuses a relative path', async () => {
    expect(
      await resolveSource({ kind: 'path', path: 'ticket.pdf' }, { downloadsDir: downloads }),
    ).toMatchObject({ ok: false, code: 'FILE_NOT_ALLOWED' });
  });

  it('refuses anything that is not a .pdf', async () => {
    for (const name of ['recu.exe', 'recu.pdf.exe', 'recu', 'recu.PDFX']) {
      const path = write(downloads, name);
      expect(
        await resolveSource({ kind: 'path', path }, { downloadsDir: downloads }),
      ).toMatchObject({ ok: false, code: 'FILE_NOT_ALLOWED' });
    }
  });

  it('refuses a directory that happens to be named .pdf', async () => {
    const path = join(downloads, 'dossier.pdf');
    mkdirSync(path);
    expect(await resolveSource({ kind: 'path', path }, { downloadsDir: downloads })).toMatchObject({
      ok: false,
      code: 'FILE_NOT_ALLOWED',
    });
  });

  it('refuses a file that does not exist', async () => {
    expect(
      await resolveSource(
        { kind: 'path', path: join(downloads, 'absent.pdf') },
        { downloadsDir: downloads },
      ),
    ).toMatchObject({ ok: false, code: 'FILE_NOT_ALLOWED' });
  });

  it('refuses a .pdf in Downloads that is not a PDF', async () => {
    const path = write(downloads, 'faux.pdf', Buffer.from('MZ this is an executable'));
    expect(await resolveSource({ kind: 'path', path }, { downloadsDir: downloads })).toMatchObject({
      ok: false,
      code: 'INVALID_RECEIPT',
    });
  });
});

describe('isInside', () => {
  it('accepts the directory itself and anything below it', () => {
    expect(isInside('/home/x/Downloads', '/home/x/Downloads')).toBe(true);
    expect(isInside('/home/x/Downloads/a/b.pdf', '/home/x/Downloads')).toBe(true);
  });

  it('rejects a sibling whose name merely starts the same', () => {
    // Without comparing on the separator, "Downloads-secret" reads as being
    // inside "Downloads".
    expect(isInside('/home/x/Downloads-secret/b.pdf', '/home/x/Downloads')).toBe(false);
  });

  it('tolerates a trailing separator on the root', () => {
    expect(isInside('/home/x/Downloads/b.pdf', '/home/x/Downloads/')).toBe(true);
  });

  it('rejects a parent directory', () => {
    expect(isInside('/home/x', '/home/x/Downloads')).toBe(false);
  });
});
