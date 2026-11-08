import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

export const NO_CONTROL_CHARACTERS = 'noControlCharacters';

// C0 controls (U+0000–U+001F, incl. NUL, TAB, CR, LF) and DEL (U+007F).
// PostgreSQL text cannot store NUL at all, and the others have no place in a
// single-line title or file name. Every other code point (accents, emoji,
// RTL letters, ...) is allowed.
// Checked by UTF-16 unit (every target is a single BMP unit; surrogates
// are never in range) instead of a regex, which `no-control-regex` forbids.
const LAST_C0_CONTROL = 0x1f;
const DEL = 0x7f;

function isControlUnit(unit: number): boolean {
  return unit <= LAST_C0_CONTROL || unit === DEL;
}

export function hasNoControlCharacters(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    if (isControlUnit(value.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

export function NoControlCharacters(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: NO_CONTROL_CHARACTERS,
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return hasNoControlCharacters(value);
        },
        defaultMessage(args?: ValidationArguments): string {
          const property = args?.property ?? 'value';
          return `${property} must be a string without control characters`;
        },
      },
    });
  };
}
