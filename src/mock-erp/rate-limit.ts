/** In-process token bucket (the mock is a single process). Rate and burst can change at runtime. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private rps: number,
    private burst: number,
  ) {
    this.tokens = burst;
  }

  configure(rps: number, burst: number): void {
    this.rps = rps;
    this.burst = burst;
    this.tokens = Math.min(this.tokens, burst);
  }

  tryTake(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.rps) / 1000);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
