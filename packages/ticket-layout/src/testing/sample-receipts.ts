import type { Receipt } from '@brb/shared';

/**
 * Hand-written receipts for layout tests.
 *
 * These are SYNTHETIC. They exist so phase 1.5a can be validated with no real
 * Booksy PDF and no customer data. Phase 3 replaces them with parser output.
 */

/** A plain, well-behaved ticket. */
export function nominalReceipt(): Receipt {
  return {
    source: 'booksy',
    ticket: {
      number: '996',
      operationType: 'Vente',
      issuedAt: '2026-03-14T15:09:00.000Z',
    },
    merchant: {
      name: 'Salon Démo',
      siret: '123 456 789 00012',
      vatNumber: 'FR12345678901',
      nafCode: '9602A',
      address: ['12 rue de Nulle Part', '75001 Paris'],
    },
    customer: { id: 'C-4211', name: 'Client Démo' },
    items: [
      { label: 'Coupe femme', quantity: 1, unitPrice: 25, total: 25, vatRate: 20, kind: 'service' },
      { label: 'Shampooing 250 ml', quantity: 2, unitPrice: 9.5, total: 19, vatRate: 20, kind: 'product' },
    ],
    totals: { subtotal: 36.67, totalTTC: 44 },
    vat: [{ rate: 20, base: 36.67, amount: 7.33 }],
    payment: { method: 'Carte bancaire', amount: 44 },
    certification: {
      software: 'Booksy',
      softwareId: 'BK-1234',
      certification: 'NF525 n° 042',
      signatureTimestamp: '2026-03-14T15:09:01.000Z',
      signature: 'MEUCIQDf9k2mQxTn4pLwR7hVb3Yc1sJZaKm5Nn8Ee2Rr0Tt6Uu',
    },
  };
}

/** Long labels, multiple VAT rates, an accented and euro-heavy ticket. */
export function stressReceipt(): Receipt {
  return {
    source: 'booksy',
    ticket: { number: '1042-A', operationType: 'Vente à emporter', issuedAt: '14/03/2026 15:09' },
    merchant: {
      name: 'Établissement à la Dénomination Particulièrement Longue',
      siret: '987 654 321 00099',
      vatNumber: 'FR98765432109',
      nafCode: '9602B',
      address: ['1 avenue des Champs-Élysées, bâtiment C, escalier 4', '75008 Paris', 'France'],
    },
    customer: { name: 'Marie-Ségolène de La Tour-d’Auvergne' },
    items: [
      {
        label: 'Coloration complète avec balayage, mèches et soin réparateur profond',
        quantity: 1,
        unitPrice: 189.9,
        total: 189.9,
        vatRate: 20,
        kind: 'service',
      },
      { label: 'Café', quantity: 3, unitPrice: 2.5, total: 7.5, vatRate: 10, kind: 'product' },
      { label: 'Sérum 30 ml', quantity: 1, unitPrice: 45, total: 45, vatRate: 20, kind: 'product' },
      { label: 'Remise fidélité', total: -20, vatRate: 20 },
    ],
    totals: { subtotal: 202.14, totalTTC: 222.4 },
    vat: [
      { rate: 20, base: 195.36, amount: 39.07 },
      { rate: 10, base: 6.82, amount: 0.68 },
      { rate: 5.5, base: 0, amount: 0 },
    ],
    payment: { method: 'Espèces', amount: 222.4 },
    certification: {
      software: 'Booksy Caisse Certifiée',
      softwareId: 'BK-CAISSE-2026-0001-XYZ',
      certification: 'Certification NF525 délivrée par Infocert n° 2026/0042/AB',
      signatureTimestamp: '2026-03-14T15:09:01+01:00',
      signature:
        'MEUCIQDf9k2mQxTn4pLwR7hVb3Yc1sJZaKm5Nn8Ee2Rr0Tt6UuAiEA7Wz1Xx4Yy9Zz0Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj',
    },
  };
}

/** Only what the model makes mandatory - everything optional is absent. */
export function minimalReceipt(): Receipt {
  return {
    source: 'booksy',
    ticket: { number: '1' },
    merchant: { name: 'X' },
    items: [{ label: 'Prestation', total: 10 }],
    totals: { totalTTC: 10 },
    vat: [],
  };
}
