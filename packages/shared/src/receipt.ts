/**
 * Fiscal receipt model (plan section 30).
 *
 * FISCAL INVARIANT (plan section 31): every numeric field here is *read* from the
 * source document. Nothing in this codebase may recompute a VAT amount, a total, a
 * unit price or a discount. Inconsistencies are reported as ParseWarning, never
 * silently corrected.
 *
 * KNOWN LIMITATION carried into phase 2: amounts are stored as `number`, so the
 * exact textual form printed on the original PDF ("12,50 €") is not preserved. If
 * fiscal fidelity ever requires reprinting the byte-identical string, these fields
 * need a companion raw string. Deliberately deferred - see README.
 */

export interface ReceiptItem {
  /** Service or product label, as printed on the source document. */
  label: string;
  quantity?: number;
  unitPrice?: number;
  /** Line total as printed. Never derived from quantity * unitPrice. */
  total: number;
  /** VAT rate in percent, as printed (e.g. 20 for 20%). */
  vatRate?: number;
  kind?: 'service' | 'product';
}

export interface VatLine {
  /** VAT rate in percent, as printed. */
  rate: number;
  /** Taxable base as printed. */
  base?: number;
  /** VAT amount as printed. */
  amount: number;
}

export interface Receipt {
  source: 'booksy';

  ticket: {
    number: string;
    operationType?: string;
    /** ISO 8601 when parseable, otherwise the raw printed string. */
    issuedAt?: string;
  };

  merchant: {
    name: string;
    siret?: string;
    vatNumber?: string;
    nafCode?: string;
    address?: string[];
  };

  customer?: {
    id?: string;
    name?: string;
  };

  items: ReceiptItem[];

  totals: {
    subtotal?: number;
    totalTTC: number;
  };

  vat: VatLine[];

  payment?: {
    method?: string;
    amount?: number;
  };

  /** NF525 certification block. Must be reproduced verbatim (AC11). */
  certification?: {
    software?: string;
    softwareId?: string;
    certification?: string;
    signatureTimestamp?: string;
    signature?: string;
  };
}

export type ParseWarningCode =
  | 'MISSING_FIELD'
  | 'AMBIGUOUS_FIELD'
  | 'ITEMS_SUM_MISMATCH'
  | 'VAT_SUM_MISMATCH'
  | 'UNPARSEABLE_DATE'
  | 'UNEXPECTED_LAYOUT';

export interface ParseWarning {
  code: ParseWarningCode;
  /** Dot path into Receipt, e.g. "totals.totalTTC". */
  field?: string;
  message: string;
}

export interface ParseResult {
  receipt: Receipt;
  /** 0..1 - see plan section 34. Auto-print requires >= threshold. */
  confidence: number;
  warnings: ParseWarning[];
}
