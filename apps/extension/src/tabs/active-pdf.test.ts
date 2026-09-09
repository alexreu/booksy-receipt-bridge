import { describe, expect, it } from 'vitest';
import { activeTabPdfOf, activeTabResultOf, basenameOfUrl, localPathOf } from './active-pdf.ts';

describe('activeTabPdfOf', () => {
  it('recognises a PDF by its path', () => {
    expect(
      activeTabPdfOf({ url: 'https://booksy.com/fr-fr/recu/recu-1167.pdf', title: 'recu-1167.pdf' }),
    ).toEqual({ name: 'recu-1167.pdf', url: 'https://booksy.com/fr-fr/recu/recu-1167.pdf' });
  });

  it('recognises a PDF served from a URL that says nothing', () => {
    // The built-in viewer sets the tab title to the filename, which is often
    // the only place the .pdf shows up.
    expect(activeTabPdfOf({ url: 'https://booksy.com/download/9f3a', title: 'recu-1167.pdf' })).toEqual(
      { name: 'recu-1167.pdf', url: 'https://booksy.com/download/9f3a' },
    );
  });

  it('ignores the query string when reading the path', () => {
    const pdf = activeTabPdfOf({ url: 'https://x.example/a/recu.pdf?token=abc', title: 'Reçu' });
    expect(pdf?.name).toBe('recu.pdf');
  });

  it('works from any site, since the receipt is just a PDF in a tab', () => {
    expect(activeTabPdfOf({ url: 'https://autre.example/x/t.pdf', title: 't.pdf' })).not.toBeNull();
  });

  it('leaves an ordinary page alone', () => {
    expect(activeTabPdfOf({ url: 'https://booksy.com/fr-fr/', title: 'Booksy' })).toBeNull();
    expect(activeTabPdfOf({ url: 'https://x.example/a.html', title: 'Page' })).toBeNull();
  });

  it('refuses a scheme with nothing printable behind it', () => {
    // blob: and data: hold no path the service could open and no address the
    // worker may fetch; the others are not documents at all.
    for (const url of [
      'blob:https://x.example/abc',
      'data:application/pdf;base64,JVBERi0=',
      'chrome-extension://abc/popup/index.html',
      'chrome://settings',
    ]) {
      expect(activeTabPdfOf({ url, title: 'recu.pdf' }), url).toBeNull();
    }
  });

  it('accepts a local PDF, which the service will open by path', () => {
    // The browser never reads the file: the worker hands the service the path
    // and the service re-validates it against its allowed directories.
    expect(activeTabPdfOf({ url: 'file:///Users/x/Downloads/recu-1167.pdf' })).toEqual({
      name: 'recu-1167.pdf',
      url: 'file:///Users/x/Downloads/recu-1167.pdf',
    });
  });

  it('refuses a file URL that points at another machine', () => {
    // A UNC share is not this filesystem, and the service would refuse it.
    expect(
      activeTabPdfOf({ url: 'file://serveur/partage/recu.pdf', title: 'recu.pdf' }),
    ).toBeNull();
  });

  it('refuses a tab with no url', () => {
    expect(activeTabPdfOf(undefined)).toBeNull();
    expect(activeTabPdfOf({})).toBeNull();
    expect(activeTabPdfOf({ url: '' })).toBeNull();
    expect(activeTabPdfOf({ url: 'pas une url', title: 'x.pdf' })).toBeNull();
  });

  it('is case-insensitive about the extension', () => {
    expect(activeTabPdfOf({ url: 'https://x.example/RECU.PDF' })).not.toBeNull();
    expect(activeTabPdfOf({ url: 'https://x.example/d', title: 'RECU.PDF' })).not.toBeNull();
  });

  it('does not match a name that merely contains pdf', () => {
    expect(activeTabPdfOf({ url: 'https://x.example/pdf-viewer', title: 'pdf viewer' })).toBeNull();
  });
});

describe('basenameOfUrl', () => {
  it('takes the last path segment', () => {
    expect(basenameOfUrl(new URL('https://x.example/a/b/recu-1.pdf'))).toBe('recu-1.pdf');
  });

  it('decodes percent-escapes so the name reads properly', () => {
    expect(basenameOfUrl(new URL('https://x.example/re%C3%A7u-1.pdf'))).toBe('reçu-1.pdf');
  });

  it('falls back to the hostname when there is no path', () => {
    expect(basenameOfUrl(new URL('https://x.example/'))).toBe('x.example');
  });
});

describe('activeTabResultOf', () => {
  it('reports a PDF it can print', () => {
    expect(activeTabResultOf({ url: 'https://x.example/recu.pdf', title: 'recu.pdf' })).toEqual({
      pdf: { name: 'recu.pdf', url: 'https://x.example/recu.pdf' },
    });
  });

  it('distinguishes a tab it has no access to from one that is not a PDF', () => {
    // activeTab is granted only when the user invokes the extension; until then
    // tabs.query returns a tab with no url. Observed as `[{}]` while testing.
    expect(activeTabResultOf({})).toEqual({ pdf: null, reason: 'no-permission' });
    expect(activeTabResultOf({ url: '' })).toEqual({ pdf: null, reason: 'no-permission' });
    expect(activeTabResultOf({ url: 'https://x.example/page.html' })).toEqual({
      pdf: null,
      reason: 'not-a-pdf',
    });
  });

  it('reports when there is no tab at all', () => {
    expect(activeTabResultOf(undefined)).toEqual({ pdf: null, reason: 'no-tab' });
  });
});

describe('localPathOf', () => {
  it('gives the path a local file URL stands for', () => {
    expect(localPathOf('file:///Users/x/Downloads/recu-1167.pdf')).toBe(
      '/Users/x/Downloads/recu-1167.pdf',
    );
  });

  it('decodes what the URL escaped', () => {
    expect(localPathOf('file:///Users/x/Downloads/re%C3%A7u%201167.pdf')).toBe(
      '/Users/x/Downloads/reçu 1167.pdf',
    );
  });

  it('drops the slash Windows drive letters arrive with', () => {
    // file:///C:/... parses to /C:/..., which is not a path Node accepts.
    expect(localPathOf('file:///C:/Users/x/Downloads/recu.pdf')).toBe(
      'C:/Users/x/Downloads/recu.pdf',
    );
  });

  it('gives nothing for what is not a local file URL', () => {
    for (const url of [
      'https://booksy.com/recu/1167.pdf',
      'file://serveur/partage/recu.pdf',
      'pas une url',
    ]) {
      expect(localPathOf(url), url).toBeUndefined();
    }
  });
});
