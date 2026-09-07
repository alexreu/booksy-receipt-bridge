import { describe, expect, it } from 'vitest';
import type { DetectedReceipt } from '../downloads/store.ts';
import { CAUTION_THRESHOLD, detectedRows, formatMoney } from './detected.ts';

function receipt(overrides: Partial<DetectedReceipt> = {}): DetectedReceipt {
  return {
    downloadId: 42,
    path: '/Users/x/Downloads/recu-1167.pdf',
    ticketNumber: '1167',
    totalTTC: 300,
    issuedAt: '11/08/2026, 16:08:54',
    confidence: 1,
    warningCount: 0,
    detectedAt: 1_700,
    reason: 'booksy',
    ...overrides,
  };
}

describe('formatMoney', () => {
  it('uses the French comma and the euro sign', () => {
    expect(formatMoney(300)).toBe('300,00 €');
    expect(formatMoney(9.5)).toBe('9,50 €');
    expect(formatMoney(-20)).toBe('-20,00 €');
  });
});

describe('detectedRows', () => {
  it('names the ticket and its total', () => {
    const [row] = detectedRows([receipt()]);
    expect(row?.label).toBe('Ticket n° 1167 · 300,00 €');
    expect(row?.detail).toBe('11/08/2026, 16:08:54');
    expect(row?.printed).toBe(false);
    expect(row?.caution).toBeUndefined();
  });

  it('says so once printed, instead of offering again', () => {
    const [row] = detectedRows([receipt({ printedAt: 2_000 })]);
    expect(row?.printed).toBe(true);
    expect(row?.detail).toBe('déjà imprimé');
  });

  it('warns when the reading was uncertain', () => {
    const [row] = detectedRows([receipt({ confidence: 0.6 })]);
    expect(row?.caution).toContain('60 %');
    expect(row?.caution).toContain('incertaine');
  });

  it('warns when the parser flagged anomalies, and counts them properly', () => {
    expect(detectedRows([receipt({ warningCount: 1 })])[0]?.caution).toContain('1 anomalie');
    expect(detectedRows([receipt({ warningCount: 3 })])[0]?.caution).toContain('3 anomalies');
  });

  it('says when only the filename matched', () => {
    // So the user knows the provenance was the weaker signal.
    const [row] = detectedRows([receipt({ reason: 'filename' })]);
    expect(row?.caution).toContain('nom de fichier');
  });

  it('says nothing extra for a clean Booksy receipt', () => {
    expect(detectedRows([receipt()])[0]?.caution).toBeUndefined();
  });

  it('drops the cautions once printed - they are about deciding, not history', () => {
    const [row] = detectedRows([
      receipt({ printedAt: 2_000, confidence: 0.4, warningCount: 2, reason: 'filename' }),
    ]);
    expect(row?.caution).toBeUndefined();
  });

  it('falls back when the receipt carries no date', () => {
    const [row] = detectedRows([receipt({ issuedAt: undefined })]);
    expect(row?.detail).toBe('téléchargé à l’instant');
  });

  it('keeps the caution threshold in step with the auto-print default', () => {
    expect(CAUTION_THRESHOLD).toBe(0.9);
  });

  it('returns nothing for an empty list', () => {
    expect(detectedRows([])).toEqual([]);
  });
});
