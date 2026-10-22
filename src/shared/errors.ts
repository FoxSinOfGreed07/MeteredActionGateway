export class GatewayError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

export function isPgError(err: unknown, sqlState: string, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as PgErrorLike;
  return e.code === sqlState && (constraint === undefined || e.constraint === constraint);
}

/** SQLSTATE 23505 unique_violation, optionally for a specific constraint/index name. */
export function isPgUniqueViolation(err: unknown, constraint?: string): boolean {
  return isPgError(err, '23505', constraint);
}
