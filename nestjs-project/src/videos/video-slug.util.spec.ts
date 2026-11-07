import { generateVideoSlug } from './video-slug.util';

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
