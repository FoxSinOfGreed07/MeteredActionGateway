import { z } from 'zod';

export const TASK = 'invoice_line_category';
export const SCHEMA_VERSION = 1;

export const CATEGORIES = [
  'IT_INFRASTRUCTURE',
  'SOFTWARE_SUBSCRIPTIONS',
  'PROFESSIONAL_SERVICES',
  'TRAVEL',
  'OFFICE_SUPPLIES',
  'UTILITIES',
  'RENT',
  'MARKETING',
  'LOGISTICS',
  'RAW_MATERIALS',
  'OTHER',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const ClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(200),
});
export type ClassificationResult = z.infer<typeof ClassificationSchema>;
