/** A15: scenario tests scale the doc's durations. `SCENARIO_TIME_SCALE=1` runs the exact numbers. */
export const SCALE = Number(process.env.SCENARIO_TIME_SCALE ?? '0.1');
export const T = (ms: number): number => Math.max(1, Math.round(ms * SCALE));
