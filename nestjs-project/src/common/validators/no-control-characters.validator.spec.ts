import { validate } from 'class-validator';
import {
  NO_CONTROL_CHARACTERS,
  NoControlCharacters,
} from './no-control-characters.validator';

class NameHolder {
  @NoControlCharacters()
  name: unknown;
}

async function errorsFor(name: unknown) {
  const holder = new NameHolder();
  holder.name = name;
  return validate(holder);
}

describe('NoControlCharacters', () => {
  it.each([
    ['plain ASCII', 'My first video'],
    ['accents', 'Férias: ação à noite'],
    ['emoji', '\u{1F3AC} clip \u{1F600}'],
    ['RTL letters', 'فيديو עברית'],
    ['CJK', '動画のタイトル'],
    ['C1 range and NBSP', 'a\u0085b c'],
    ['an empty string', ''],
  ])('should accept %s', async (_label, value) => {
    expect(await errorsFor(value)).toHaveLength(0);
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['a leading NUL', '\u0000clip.mp4'],
    ['TAB', 'a\tb'],
    ['LF', 'a\nb'],
    ['CR', 'a\rb'],
    ['ESC', 'a\u001Bb'],
    ['U+001F', 'a\u001Fb'],
    ['DEL', 'a\u007Fb'],
  ])('should reject %s', async (_label, value) => {
    const errors = await errorsFor(value);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('name');
    expect(errors[0].constraints).toEqual({
      [NO_CONTROL_CHARACTERS]:
        'name must be a string without control characters',
    });
  });

  it.each([[123], [null], [undefined], [['a']], [{ name: 'a' }]])(
    'should reject the non-string value %p',
    async (value) => {
      const errors = await errorsFor(value);

      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty(NO_CONTROL_CHARACTERS);
    },
  );

  it('should use a custom message when one is given', async () => {
    class Custom {
      @NoControlCharacters({ message: 'bad name' })
      name = 'a\u0000';
    }

    const errors = await validate(new Custom());

    expect(errors[0].constraints).toEqual({
      [NO_CONTROL_CHARACTERS]: 'bad name',
    });
  });
});
