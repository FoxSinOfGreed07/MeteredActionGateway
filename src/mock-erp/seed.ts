import type { Prng } from './prng.js';
import type { Invoice, Vendor } from './types.js';

const NAMES = [
  'Shakti',
  'Vayu',
  'Kaveri',
  'Sahyadri',
  'Indus',
  'Ganga',
  'Nilgiri',
  'Deccan',
  'Konark',
  'Ajanta',
];
const SUFFIX = ['Traders', 'Logistics', 'Infotech', 'Steel', 'Packaging', 'Services', 'Cloud', 'Chemicals'];

export const pad = (n: number, width: number) => String(n).padStart(width, '0');
export const vendorId = (n: number) => `V-${pad(n, 4)}`;
export const invoiceId = (cc: string, n: number) => `INV-${cc}-${pad(n, 5)}`;

export function makeVendor(prng: Prng, cc: string, n: number, at: string): Vendor {
  return {
    vendor_id: vendorId(n),
    company_code: cc,
    name: `${prng.pick(NAMES)} ${prng.pick(SUFFIX)} Pvt Ltd`,
    gstin: `${pad(prng.int(1, 37), 2)}${prng.letters(5)}${prng.digits(4)}${prng.letters(1)}1Z${prng.alnum(1)}`,
    bank_account: { account_number: prng.digits(12), ifsc: `${prng.letters(4)}0${prng.alnum(6)}` },
    payment_terms_days: prng.pick([15, 30, 45, 60]),
    blocked: false,
    seq: 1,
    updated_at: at,
  };
}

export function makeInvoice(
  prng: Prng,
  cc: string,
  n: number,
  vendor: string,
  at: string,
  amountMinor?: number,
): Invoice {
  // ₹1,000.00 – ₹5,00,000.00 in paise
  const amount = amountMinor ?? prng.int(1_000, 500_000) * 100;
  const due = new Date(Date.parse(at) + prng.int(1, 60) * 86_400_000).toISOString().slice(0, 10);
  return {
    invoice_id: invoiceId(cc, n),
    company_code: cc,
    vendor_id: vendor,
    amount_minor: amount,
    currency: 'INR',
    status: 'OPEN',
    open_amount_minor: amount,
    due_date: due,
    seq: 1,
    updated_at: at,
  };
}
