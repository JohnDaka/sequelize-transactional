/** The answers of `typeof` that the checks below compare against. */
const TYPE_OF = {
  /** What `typeof` answers for a function, a method or a class: anything that can be called. */
  FUNCTION: 'function',
} as const;

/** Anything that can be called: what it takes and returns is the caller's business. */
export type Callable = (...args: never[]) => unknown;

/**
 * Whether the value can be called. A type guard rather than an inline `typeof`: TypeScript
 * narrows on a guard, not on a comparison with a named constant.
 *
 * @param value - The value to check.
 * @returns Whether it is a function, a method or a class.
 */
export const isFunction = (value: unknown): value is Callable => typeof value === TYPE_OF.FUNCTION;
