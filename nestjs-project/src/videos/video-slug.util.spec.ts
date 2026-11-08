import { generateVideoSlug, isVideoSlug } from './video-slug.util';

describe('generateVideoSlug', () => {
  it('should return an 11-character string', () => {
    expect(generateVideoSlug()).toHaveLength(11);
  });

  it('should use only the base64url alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateVideoSlug()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should return distinct values across calls', () => {
    const slugs = new Set(Array.from({ length: 1000 }, generateVideoSlug));

    expect(slugs.size).toBe(1000);
  });
});

describe('isVideoSlug', () => {
  it('should accept generated slugs', () => {
    for (let i = 0; i < 50; i++) {
      expect(isVideoSlug(generateVideoSlug())).toBe(true);
    }
  });

  it.each(['AbCdEfGhIjK', 'a-b_c-d_e-f', '___________', '01234567890'])(
    'should accept the 11-char base64url slug %p',
    (slug) => {
      expect(isVideoSlug(slug)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['10 chars', 'AbCdEfGhIj'],
    ['12 chars', 'AbCdEfGhIjKl'],
    ['NUL', '\u0000'],
    ['NUL inside 11 chars', 'AbCdE\u0000GhIjK'],
    ['padding', 'AbCdEfGhIj='],
    ['standard base64 chars', 'AbCdEf+hIj/'],
    ['a trailing newline', 'AbCdEfGhIjK\n'],
    ['non-ASCII', 'AbCdEfGhIjé'],
    ['a dot', 'AbCdE.GhIjK'],
  ])('should reject %s', (_label, value) => {
    expect(isVideoSlug(value)).toBe(false);
  });
});
