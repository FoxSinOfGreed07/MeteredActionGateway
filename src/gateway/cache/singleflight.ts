/** In-process request coalescing: concurrent callers for one key share one in-flight promise (D6). */
export class SingleFlight<T> {
  private readonly flights = new Map<string, Promise<T>>();

  /** Returns [promise, leader]: `leader` is true for the caller that started the work. */
  do(key: string, fn: () => Promise<T>): [Promise<T>, boolean] {
    const existing = this.flights.get(key);
    if (existing) return [existing, false];
    const p = fn().finally(() => this.flights.delete(key)); // never cache a failure past its flight
    this.flights.set(key, p);
    return [p, true];
  }
}
