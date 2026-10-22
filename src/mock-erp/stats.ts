export function createStats() {
  return {
    requests_by_route: {} as Record<string, number>,
    reads: { vendor: {} as Record<string, number>, invoice: {} as Record<string, number>, payment_lookup: 0 },
    payment_posts_received: 0,
    payments_created: 0,
    responses_by_status: {} as Record<string, number>,
    rate_limited_429: 0,
    faults_applied: {} as Record<string, number>,
    webhooks: { sent: 0, failed: 0, pending: 0, dropped: 0 },
  };
}

export type Stats = ReturnType<typeof createStats>;

export function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}
