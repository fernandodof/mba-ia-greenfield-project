type MethodKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/**
 * Like `jest.Mocked<T>`, but exposes each method as a plain `jest.Mock`
 * property instead of a method signature. Passing these mocks to `expect()`
 * does not trip `@typescript-eslint/unbound-method`.
 */
export type MockedMethods<T> = {
  [K in MethodKeys<T>]: T[K] extends (...args: infer A) => infer R
    ? jest.Mock<R, A>
    : never;
};
