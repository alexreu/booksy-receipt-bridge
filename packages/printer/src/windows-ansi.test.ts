import { describe, expect, it } from 'vitest';
import { toWindowsAnsi } from './windows-ansi.ts';

function bytesOf(text: string): number[] {
  return Array.from(toWindowsAnsi(text));
}

describe('toWindowsAnsi', () => {
  it('writes the accents a French receipt is made of', () => {
    // Handing the print processor UTF-8 turns every accent into two wrong
    // characters, on a document that is mostly names and amounts.
    expect(bytesOf('é')).toEqual([0xe9]);
    expect(bytesOf('à')).toEqual([0xe0]);
    expect(bytesOf('ç')).toEqual([0xe7]);
  });

  it('writes the euro sign where Windows-1252 keeps it', () => {
    // 0x80, a position Latin-1 leaves empty - which is exactly why the code
    // page matters here.
    expect(bytesOf('€')).toEqual([0x80]);
  });

  it('substitutes what the code page cannot hold', () => {
    expect(bytesOf('漢')).toEqual([0x3f]);
  });

  it('ends every line with CRLF', () => {
    // A print processor reading a bare LF can run the whole ticket into one
    // line.
    expect(bytesOf('a\nb')).toEqual([0x61, 0x0d, 0x0a, 0x62]);
    expect(bytesOf('a\r\nb')).toEqual([0x61, 0x0d, 0x0a, 0x62]);
  });
});
