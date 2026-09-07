import { describe, expect, it } from 'vitest';
import {
  isMoney,
  parseMoney,
  parseQuantity,
  parseRate,
  sameAmount,
} from './money.ts';

describe('parseMoney', () => {
  it('reads the format real receipts use', () => {
    expect(parseMoney('300,00 €')).toBe(300);
    expect(parseMoney('50,00 €')).toBe(50);
    expect(parseMoney('0,00 €')).toBe(0);
  });

  it('reads grouped thousands', () => {
    expect(parseMoney('1 234,56 €')).toBe(1234.56);
    expect(parseMoney('1 234,56 €')).toBe(1234.56);
    expect(parseMoney('1.234,56 €')).toBe(1234.56);
    expect(parseMoney('12 345 678,90 €')).toBe(12345678.9);
  });

  it('reads a negative amount, both minus signs', () => {
    expect(parseMoney('-20,00 €')).toBe(-20);
    expect(parseMoney('−20,00 €')).toBe(-20);
  });

  it('accepts a non-breaking space before the euro sign', () => {
    expect(parseMoney('300,00 €')).toBe(300);
    expect(parseMoney('300,00€')).toBe(300);
  });

  it('rejects anything that is not an amount', () => {
    for (const text of ['300', '300,00', '€', 'T2000', '20%', '300.00 €', '', 'x1']) {
      expect(parseMoney(text)).toBeUndefined();
      expect(isMoney(text)).toBe(false);
    }
  });

  it('rejects a malformed cents group', () => {
    expect(parseMoney('300,0 €')).toBeUndefined();
    expect(parseMoney('300,000 €')).toBeUndefined();
  });
});

describe('parseRate', () => {
  it('reads integer and decimal rates', () => {
    expect(parseRate('20%')).toBe(20);
    expect(parseRate('20 %')).toBe(20);
    expect(parseRate('5,5%')).toBe(5.5);
    expect(parseRate('5.5%')).toBe(5.5);
    expect(parseRate('0%')).toBe(0);
  });

  it('rejects a non-rate', () => {
    expect(parseRate('20')).toBeUndefined();
    expect(parseRate('T2000')).toBeUndefined();
  });
});

describe('parseQuantity', () => {
  it('reads the x-prefixed quantity Booksy prints', () => {
    expect(parseQuantity('x1')).toBe(1);
    expect(parseQuantity('x 3')).toBe(3);
    expect(parseQuantity('X2')).toBe(2);
    expect(parseQuantity('x1,5')).toBe(1.5);
  });

  it('rejects a bare number', () => {
    expect(parseQuantity('1')).toBeUndefined();
  });
});

describe('sameAmount', () => {
  it('compares to the cent', () => {
    expect(sameAmount(300, 300.001)).toBe(true);
    expect(sameAmount(300, 300.01)).toBe(false);
    // Floating point: 0.1 + 0.2 must still read as 0.3.
    expect(sameAmount(0.1 + 0.2, 0.3)).toBe(true);
  });
});
