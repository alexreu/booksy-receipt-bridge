import { describe, expect, it } from 'vitest';
import {
  basenameOf,
  candidateReason,
  isBooksyHost,
  isCandidate,
  isComplete,
  isPdf,
  looksLikeReceiptName,
  type DownloadCandidate,
} from './filter.ts';

function download(overrides: Partial<DownloadCandidate> = {}): DownloadCandidate {
  return {
    id: 1,
    filename: '/Users/x/Downloads/recu-1167.pdf',
    url: 'https://booksy.com/fr-fr/recu/1167.pdf',
    state: 'complete',
    exists: true,
    ...overrides,
  };
}

describe('isBooksyHost', () => {
  it('accepts Booksy and its subdomains', () => {
    expect(isBooksyHost('https://booksy.com/x')).toBe(true);
    expect(isBooksyHost('https://fr.booksy.com/x')).toBe(true);
    expect(isBooksyHost('https://cdn.booksy.net/x')).toBe(true);
  });

  it('rejects a host that merely contains the name', () => {
    // The suffix match is on a dot, so this cannot pass.
    expect(isBooksyHost('https://booksy.com.evil.example/x')).toBe(false);
    expect(isBooksyHost('https://notbooksy.com/x')).toBe(false);
    expect(isBooksyHost('https://mybooksy.com/x')).toBe(false);
  });

  it('rejects nothing and nonsense', () => {
    expect(isBooksyHost(undefined)).toBe(false);
    expect(isBooksyHost('')).toBe(false);
    expect(isBooksyHost('pas une url')).toBe(false);
  });
});

describe('looksLikeReceiptName', () => {
  it('recognises the name the real receipt downloads as', () => {
    // The plan suggested ticket-*.pdf, but the actual file is recu-1167.pdf,
    // so that pattern alone would have missed every real receipt.
    expect(looksLikeReceiptName('/Users/x/Downloads/recu-1167.pdf')).toBe(true);
    expect(looksLikeReceiptName('/Users/x/Downloads/reçu-1167.pdf')).toBe(true);
    expect(looksLikeReceiptName('C:\\Users\\x\\Downloads\\ticket-996.pdf')).toBe(true);
    expect(looksLikeReceiptName('receipt_42.pdf')).toBe(true);
  });

  it('needs a digit, so a prose filename does not match', () => {
    expect(looksLikeReceiptName('recu.pdf')).toBe(false);
    expect(looksLikeReceiptName('tickets de caisse.pdf')).toBe(false);
  });

  it('is anchored at the start of the name', () => {
    expect(looksLikeReceiptName('mon-recu-1167.pdf')).toBe(false);
    expect(looksLikeReceiptName('facture-recu-1.pdf')).toBe(false);
  });

  it('reads the basename, not the directory', () => {
    expect(basenameOf('/Users/x/recu-1/facture.pdf')).toBe('facture.pdf');
    expect(looksLikeReceiptName('/Users/x/recu-1/facture.pdf')).toBe(false);
  });
});

describe('isComplete', () => {
  it('accepts a finished download that left a file', () => {
    expect(isComplete(download())).toBe(true);
  });

  it('refuses one still in progress', () => {
    expect(isComplete(download({ state: 'in_progress' }))).toBe(false);
    expect(isComplete(download({ state: 'interrupted' }))).toBe(false);
  });

  it('refuses one with no filename yet', () => {
    expect(isComplete(download({ filename: '' }))).toBe(false);
  });

  it('refuses a file that no longer exists', () => {
    expect(isComplete(download({ exists: false }))).toBe(false);
  });

  it('refuses a partial file', () => {
    // Chrome writes to .crdownload first; acting on one reads a partial PDF.
    expect(isComplete(download({ filename: '/Users/x/Downloads/recu.pdf.crdownload' }))).toBe(
      false,
    );
  });
});

describe('isPdf', () => {
  it('accepts a .pdf name', () => {
    expect(isPdf(download())).toBe(true);
    expect(isPdf(download({ filename: '/x/RECU.PDF' }))).toBe(true);
  });

  it('falls back to the mime type when the name does not say', () => {
    expect(isPdf(download({ filename: '/x/download', mime: 'application/pdf' }))).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isPdf(download({ filename: '/x/photo.png', mime: 'image/png' }))).toBe(false);
  });
});

describe('isCandidate', () => {
  it('accepts a completed Booksy PDF', () => {
    expect(isCandidate(download())).toBe(true);
  });

  it('accepts one identified by its referrer', () => {
    expect(
      isCandidate(
        download({
          url: 'https://files.example.com/blob/abc',
          referrer: 'https://booksy.com/fr-fr/recu/1167',
          filename: '/Users/x/Downloads/download.pdf',
        }),
      ),
    ).toBe(true);
  });

  it('accepts a receipt-shaped name from anywhere', () => {
    // Covers a file re-saved or moved outside the browser flow.
    expect(
      isCandidate(download({ url: 'https://ailleurs.example/x.pdf', referrer: undefined })),
    ).toBe(true);
  });

  it('leaves an unrelated PDF alone', () => {
    // Handing the parser every PDF the user downloads - bank statements,
    // contracts - is more access than this feature needs.
    expect(
      isCandidate(
        download({
          url: 'https://ma-banque.example/releve.pdf',
          referrer: 'https://ma-banque.example/',
          filename: '/Users/x/Downloads/releve-compte.pdf',
        }),
      ),
    ).toBe(false);
  });

  it('leaves a non-PDF from Booksy alone', () => {
    expect(isCandidate(download({ filename: '/Users/x/Downloads/photo.jpg' }))).toBe(false);
  });

  it('waits for the download to finish', () => {
    expect(isCandidate(download({ state: 'in_progress' }))).toBe(false);
  });
});

describe('candidateReason', () => {
  it('says which signal matched, so the popup can be honest about it', () => {
    expect(candidateReason(download())).toBe('booksy');
    expect(
      candidateReason(download({ url: 'https://ailleurs.example/x', referrer: undefined })),
    ).toBe('filename');
  });
});
