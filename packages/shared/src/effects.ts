/**
 * The impure inputs, made explicit.
 *
 * Time and randomness are the two things that stop a function being a function.
 * Rather than reach for `Date.now()` and `Math.random()` wherever they are
 * wanted, every caller takes them as an argument. A test then pins them and the
 * result is reproducible; nothing has a hidden default that could quietly make
 * it non-deterministic again.
 */

/** Epoch milliseconds. */
export type Clock = () => number;

/** Correlation ids. Unique within a session; not secrets. */
export type IdSource = () => string;

export const systemClock: Clock = () => Date.now();

/**
 * Ids that depend only on the clock and on how many were asked for.
 *
 * A counter rather than `Math.random()`: the ids only have to be distinct
 * inside one session, and a counter makes the sequence reproducible.
 */
export function createIdSource(clock: Clock, prefix = 'x'): IdSource {
  let counter = 0;
  const session = clock().toString(36);
  return () => {
    counter += 1;
    return `${prefix}-${session}-${counter.toString(36)}`;
  };
}

/** A clock that does not move. For tests. */
export function fixedClock(at: number): Clock {
  return () => at;
}

/** A clock the test advances by hand. */
export function stepClock(start: number, stepMs = 1000): Clock {
  let now = start - stepMs;
  return () => {
    now += stepMs;
    return now;
  };
}
