import { buildDownloadContentDisposition } from './download-filename.util';

const NBSP = String.fromCodePoint(0xa0);

function disposition(ascii: string, encoded: string): string {
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

describe('buildDownloadContentDisposition', () => {
  it('should build the plan example: forbidden characters removed, non-ASCII → _ and UTF-8 encoded', () => {
    expect(buildDownloadContentDisposition('Férias: dia 1/2', 'clip.MP4')).toBe(
      disposition('F_rias dia 12.mp4', 'F%C3%A9rias%20dia%2012.mp4'),
    );
  });

  it('should remove control characters and / \\ : * ? " < > |', () => {
    expect(
      buildDownloadContentDisposition(
        'a/b\\c:d*e?f"g<h>i|j\u0000k\u007Fl',
        'x.mp4',
      ),
    ).toBe(disposition('abcdefghijkl.mp4', 'abcdefghijkl.mp4'));
  });

  it('should collapse whitespace runs (incl. NBSP) into one space', () => {
    expect(
      buildDownloadContentDisposition(`My   big ${NBSP} clip`, 'x.mp4'),
    ).toBe(disposition('My big clip.mp4', 'My%20big%20clip.mp4'));
  });

  it('should trim leading spaces and trailing spaces and dots', () => {
    expect(buildDownloadContentDisposition('  My clip. . ..', 'x.mp4')).toBe(
      disposition('My clip.mp4', 'My%20clip.mp4'),
    );
  });

  it.each([
    ['empty after sanitizing', ':/?*'],
    ['only dots and spaces', ' . . '],
  ])('should fall back to "video" when the title is %s', (_case, title) => {
    expect(buildDownloadContentDisposition(title, 'x.webm')).toBe(
      disposition('video.webm', 'video.webm'),
    );
  });

  it('should keep the last extension of the original filename, lower-cased', () => {
    expect(buildDownloadContentDisposition('Clip', 'my.backup.MKV')).toBe(
      disposition('Clip.mkv', 'Clip.mkv'),
    );
  });

  it('should keep a 10-character alphanumeric extension', () => {
    expect(buildDownloadContentDisposition('Clip', 'a.abcdefghi0')).toBe(
      disposition('Clip.abcdefghi0', 'Clip.abcdefghi0'),
    );
  });

  it.each([
    ['no extension', 'noext'],
    ['an 11-character extension', 'a.verylongext'],
    ['the spec 12-character extension', 'a.verylongext1'],
    ['a non-alphanumeric extension', 'clip.mp-4'],
    ['a non-ASCII extension', 'clip.mpé'],
    ['an empty extension', 'clip.'],
  ])(
    'should omit the extension when the original filename has %s',
    (_case, filename) => {
      expect(buildDownloadContentDisposition('My clip', filename)).toBe(
        disposition('My clip', 'My%20clip'),
      );
    },
  );

  it("should percent-encode ' ( ) * in filename* and keep them in filename", () => {
    // `*` is a forbidden character, so it is gone before encoding; `'()` stay.
    expect(
      buildDownloadContentDisposition("Rock 'n' roll (live)", 'x.mp4'),
    ).toBe(
      disposition(
        "Rock 'n' roll (live).mp4",
        'Rock%20%27n%27%20roll%20%28live%29.mp4',
      ),
    );
  });

  it('should replace each non-ASCII code point (incl. surrogate pairs) with one _', () => {
    expect(buildDownloadContentDisposition('Ação 🎬 ok', 'x.mp4')).toBe(
      disposition('A__o _ ok.mp4', 'A%C3%A7%C3%A3o%20%F0%9F%8E%AC%20ok.mp4'),
    );
  });

  it('should remove U+202E RIGHT-TO-LEFT OVERRIDE so the extension cannot be spoofed', () => {
    const header = buildDownloadContentDisposition('clip‮gpj.exe', 'x.mp4');

    expect(header).toBe(disposition('clipgpj.exe.mp4', 'clipgpj.exe.mp4'));
    expect(header).not.toContain('%E2%80%AE');
  });

  it.each([
    ['LRM / RLM', 'a‎b‏c'],
    ['LRE / RLE / PDF / LRO', 'a‪b‫c‬‭'],
    ['LRI / RLI / FSI / PDI', '⁦a⁧b⁨c⁩'],
    ['ALM (U+061C)', 'a؜bc'],
    ['zero-width space / ZWNJ / ZWJ', 'a​b‌c‍'],
    ['BOM / ZWNBSP (U+FEFF)', '﻿ab﻿c'],
    ['word joiner and soft hyphen', 'a⁠b­c'],
  ])(
    'should remove bidi and invisible format characters: %s',
    (_case, title) => {
      expect(buildDownloadContentDisposition(title, 'x.mp4')).toBe(
        disposition('abc.mp4', 'abc.mp4'),
      );
    },
  );

  it('should remove format characters before collapsing whitespace and trimming', () => {
    expect(buildDownloadContentDisposition('‮ My ​ clip.⁩', 'x.mp4')).toBe(
      disposition('My clip.mp4', 'My%20clip.mp4'),
    );
  });

  it.each([
    [
      'Arabic',
      'مرحبا بالعالم',
      '_____ _______.mp4',
      '%D9%85%D8%B1%D8%AD%D8%A8%D8%A7%20%D8%A8%D8%A7%D9%84%D8%B9%D8%A7%D9%84%D9%85.mp4',
    ],
    [
      'Hebrew',
      'שלום עולם',
      '____ ____.mp4',
      '%D7%A9%D7%9C%D7%95%D7%9D%20%D7%A2%D7%95%D7%9C%D7%9D.mp4',
    ],
  ])('should keep %s (RTL) letters intact', (_case, title, ascii, encoded) => {
    expect(buildDownloadContentDisposition(title, 'x.mp4')).toBe(
      disposition(ascii, encoded),
    );
  });

  it('should fall back to "video" when the title is only control and format characters', () => {
    expect(buildDownloadContentDisposition('‮⁦​﻿\u0000‏', 'x.mp4')).toBe(
      disposition('video.mp4', 'video.mp4'),
    );
  });
});
