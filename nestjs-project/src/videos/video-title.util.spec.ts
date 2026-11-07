import { deriveVideoTitle, truncateCodePoints } from './video-title.util';

const EMOJI = '\u{1F3AC}'; // 🎬 — surrogate pair in UTF-16
const HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

describe('truncateCodePoints', () => {
  it('should keep strings at or below the limit unchanged', () => {
    expect(truncateCodePoints('abc', 3)).toBe('abc');
    expect(truncateCodePoints('ab', 3)).toBe('ab');
  });

  it('should cut by code point, never splitting a surrogate pair', () => {
    // 'a' + emoji = 3 UTF-16 units; a UTF-16 slice(0, 2) would leave a lone high surrogate.
    const result = truncateCodePoints(`a${EMOJI}${EMOJI}`, 2);

    expect(result).toBe(`a${EMOJI}`);
    expect(result).not.toMatch(HIGH_SURROGATE);
  });
});

describe('deriveVideoTitle', () => {
  it('should return the explicit title trimmed', () => {
    expect(deriveVideoTitle('  My title  ', 'file.mp4')).toBe('My title');
  });

  it('should drop only the last extension of a multi-dot filename', () => {
    expect(deriveVideoTitle(undefined, 'My clip.final.mp4')).toBe(
      'My clip.final',
    );
  });

  it('should fall back to the full filename when it is only an extension', () => {
    expect(deriveVideoTitle(undefined, '.mp4')).toBe('.mp4');
  });

  it('should keep a filename without an extension', () => {
    expect(deriveVideoTitle(undefined, 'holiday')).toBe('holiday');
  });

  it('should trim the name left after dropping the extension', () => {
    expect(deriveVideoTitle(undefined, '  holiday  .mov')).toBe('holiday');
  });

  it('should fall back to the trimmed full filename when the name is only whitespace', () => {
    expect(deriveVideoTitle(undefined, '   .mp4 ')).toBe('.mp4');
  });

  it('should cut a 300-character filename to 100 code points', () => {
    const result = deriveVideoTitle(undefined, `${'a'.repeat(300)}.mp4`);

    expect(result).toBe('a'.repeat(100));
  });

  it('should never end in half a surrogate pair when the cut lands inside one', () => {
    // 99 ASCII chars + emojis: a UTF-16 cut at 100 would split the first emoji.
    const filename = `${'a'.repeat(99)}${EMOJI.repeat(201)}.mp4`;

    const result = deriveVideoTitle(undefined, filename);

    expect(Array.from(result)).toHaveLength(100);
    expect(result).toBe(`${'a'.repeat(99)}${EMOJI}`);
    expect(result).not.toMatch(HIGH_SURROGATE);
  });

  it('should give exactly 100 code points for a 300-code-point emoji filename', () => {
    const result = deriveVideoTitle(undefined, EMOJI.repeat(300));

    expect(Array.from(result)).toHaveLength(100);
    expect(result).toBe(EMOJI.repeat(100));
  });
});
