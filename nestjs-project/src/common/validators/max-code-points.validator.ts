import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

export const MAX_CODE_POINTS = 'maxCodePoints';

// Counts Unicode code points (`Array.from`), not UTF-16 units like
// `@MaxLength`, so an emoji counts as one character — the same unit as
// PostgreSQL `varchar(n)` and `truncateCodePoints`.
export function MaxCodePoints(
  max: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: MAX_CODE_POINTS,
      target: target.constructor,
      propertyName: propertyName.toString(),
      constraints: [max],
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && Array.from(value).length <= max;
        },
        defaultMessage(args?: ValidationArguments): string {
          const property = args?.property ?? 'value';
          return `${property} must be a string with at most ${max} characters`;
        },
      },
    });
  };
}
