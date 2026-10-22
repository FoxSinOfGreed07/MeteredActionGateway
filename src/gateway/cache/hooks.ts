/**
 * How the write path tells the read cache about our own writes (D5: delete-on-write is "raise the HWM").
 * Step 06 ships a no-op; step 08 provides the real implementation.
 */
export interface CacheHooks {
  /** seq = the invoice's new seq from the payment response; null = unknown (just drop the entry). */
  onInvoiceChanged(laneId: string, companyCode: string, invoiceId: string, seq: number | null): Promise<void>;
}

export const noopCacheHooks: CacheHooks = {
  async onInvoiceChanged() {},
};
