import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatDateTime,
  formatMoney,
  formatQuantity,
  formatRate,
} from './format.ts';

describe('formatters', () => {
  it('uses the French decimal comma', () => {
    expect(formatAmount(25)).toBe('25,00');
    expect(formatAmount(9.5)).toBe('9,50');
    expect(formatAmount(-20)).toBe('-20,00');
  });

  it('appends the euro sign', () => {
    expect(formatMoney(44)).toBe('44,00 €');
  });

  it('keeps integer rates integral', () => {
    expect(formatRate(20)).toBe('20 %');
    expect(formatRate(5.5)).toBe('5,50 %');
  });

  it('formats quantities without needless decimals', () => {
    expect(formatQuantity(2)).toBe('2');
    expect(formatQuantity(1.5)).toBe('1,50');
  });

  it('formats an ISO timestamp without shifting the time zone', () => {
    // A receipt issued at 15:09 must print 15:09 whatever the machine's zone.
    expect(formatDateTime('2026-03-14T15:09:00.000Z')).toBe('14/03/2026 15:09');
    expect(formatDateTime('2026-03-14T15:09:01+01:00')).toBe('14/03/2026 15:09');
    expect(formatDateTime('2026-03-14 15:09')).toBe('14/03/2026 15:09');
  });

  it('passes through a string it cannot parse', () => {
    expect(formatDateTime('14/03/2026 15:09')).toBe('14/03/2026 15:09');
    expect(formatDateTime('sans date')).toBe('sans date');
  });
});
