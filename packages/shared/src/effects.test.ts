import { describe, expect, it } from 'vitest';
import { createIdSource, fixedClock, stepClock, systemClock } from './effects.ts';

describe('createIdSource', () => {
  it('produces the same sequence for the same clock', () => {
    // The whole point: given the same inputs, the same ids. A Math.random()
    // based source could not be asserted on at all.
    const first = createIdSource(fixedClock(1_700_000_000_000));
    const second = createIdSource(fixedClock(1_700_000_000_000));
    const take = (source: () => string): string[] => [source(), source(), source()];
    expect(take(first)).toEqual(take(second));
  });

  it('does not repeat within a session', () => {
    const source = createIdSource(fixedClock(0));
    const ids = new Set(Array.from({ length: 1000 }, () => source()));
    expect(ids.size).toBe(1000);
  });

  it('separates sessions started at different times', () => {
    const early = createIdSource(fixedClock(1_000));
    const late = createIdSource(fixedClock(2_000));
    expect(early()).not.toBe(late());
  });

  it('honours a prefix', () => {
    expect(createIdSource(fixedClock(0), 'probe')().startsWith('probe-')).toBe(true);
  });
});

describe('clocks', () => {
  it('fixedClock does not move', () => {
    const clock = fixedClock(42);
    expect([clock(), clock()]).toEqual([42, 42]);
  });

  it('stepClock advances by a fixed step, starting at the start', () => {
    const clock = stepClock(1_000, 100);
    expect([clock(), clock(), clock()]).toEqual([1_000, 1_100, 1_200]);
  });

  it('systemClock reads the real time', () => {
    const before = Date.now();
    const value = systemClock();
    expect(value).toBeGreaterThanOrEqual(before);
  });
});
