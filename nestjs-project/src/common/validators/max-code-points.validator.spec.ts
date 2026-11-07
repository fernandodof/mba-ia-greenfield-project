import { validate } from 'class-validator';
import { MAX_CODE_POINTS, MaxCodePoints } from './max-code-points.validator';

const MAX = 100;
const EMOJI = '\u{1F3AC}'; // 🎬 — one code point, two UTF-16 units

class TitleHolder {
  @MaxCodePoints(MAX)
  title: unknown;
}

async function errorsFor(title: unknown) {
  const holder = new TitleHolder();
  holder.title = title;
  return validate(holder);
}

describe('MaxCodePoints', () => {
  it('should accept an ASCII string of exactly n characters', async () => {
    expect(await errorsFor('a'.repeat(MAX))).toHaveLength(0);
  });

  it('should reject an ASCII string of n + 1 characters', async () => {
    const errors = await errorsFor('a'.repeat(MAX + 1));

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('title');
    expect(errors[0].constraints).toEqual({
      [MAX_CODE_POINTS]: `title must be a string with at most ${MAX} characters`,
    });
  });

  it('should accept n astral code points even though they are 2n UTF-16 units', async () => {
    const title = EMOJI.repeat(MAX);
    expect(title.length).toBe(MAX * 2);

    expect(await errorsFor(title)).toHaveLength(0);
  });

  it('should reject n + 1 astral code points', async () => {
    const errors = await errorsFor(EMOJI.repeat(MAX + 1));

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty(MAX_CODE_POINTS);
  });

  it('should accept an empty string', async () => {
    expect(await errorsFor('')).toHaveLength(0);
  });

  it.each([[123], [null], [undefined], [['a']], [{ title: 'a' }]])(
    'should reject the non-string value %p',
    async (value) => {
      const errors = await errorsFor(value);

      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty(MAX_CODE_POINTS);
    },
  );

  it('should use a custom message when one is given', async () => {
    class Custom {
      @MaxCodePoints(1, { message: 'too long' })
      name = 'ab';
    }

    const errors = await validate(new Custom());

    expect(errors[0].constraints).toEqual({ [MAX_CODE_POINTS]: 'too long' });
  });
});
