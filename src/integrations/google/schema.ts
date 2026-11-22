/**
 * Runtime checks for what Google's APIs send back. A response that does not
 * have the shape the reports read is refused as a whole (`bad-response`)
 * rather than shown as wrong numbers. Small on purpose: the few combinators
 * the integrations need, no dependency.
 */

export class ResponseShapeError extends Error {
  constructor(readonly path: string, expected: string) {
    super(`unexpected response: ${path} is not ${expected}`);
  }
}

export type Validator<T> = (value: unknown, path: string) => T;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export const v = {
  string: (): Validator<string> => (x, p) => {
    if (typeof x !== 'string') throw new ResponseShapeError(p, 'a string');
    return x;
  },
  number: (): Validator<number> => (x, p) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new ResponseShapeError(p, 'a number');
    return x;
  },
  boolean: (): Validator<boolean> => (x, p) => {
    if (typeof x !== 'boolean') throw new ResponseShapeError(p, 'true or false');
    return x;
  },
  /** A number sent as a string, as the GA4 Data API sends every metric value. */
  numericString: (): Validator<number> => (x, p) => {
    const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
    if (!Number.isFinite(n)) throw new ResponseShapeError(p, 'a number in a string');
    return n;
  },
  oneOf: <T extends string>(values: readonly T[]): Validator<T> => (x, p) => {
    if (typeof x !== 'string' || !values.includes(x as T)) throw new ResponseShapeError(p, `one of ${values.join(', ')}`);
    return x as T;
  },
  optional: <T>(inner: Validator<T>): Validator<T | undefined> => (x, p) => (x === undefined || x === null ? undefined : inner(x, p)),
  /** An absent array is an empty one (Google leaves out empty `rows`). */
  array: <T>(inner: Validator<T>): Validator<T[]> => (x, p) => {
    if (x === undefined || x === null) return [];
    if (!Array.isArray(x)) throw new ResponseShapeError(p, 'a list');
    return x.map((item, i) => inner(item, `${p}[${i}]`));
  },
  object: <S extends Record<string, Validator<unknown>>>(shape: S): Validator<{ [K in keyof S]: ReturnType<S[K]> }> => (x, p) => {
    if (!isObject(x)) throw new ResponseShapeError(p, 'an object');
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) out[key] = shape[key](x[key], `${p}.${key}`);
    return out as { [K in keyof S]: ReturnType<S[K]> };
  },
};

export function parse<T>(validator: Validator<T>, value: unknown): T {
  return validator(value, '$');
}
