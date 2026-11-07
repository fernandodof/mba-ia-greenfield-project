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
});
