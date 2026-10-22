import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** Action ids are generated app-side before insert; the action id IS the ERP reference (D1). */
export function newActionId(): string {
  return randomUUID();
}

export function workerId(): string {
  return `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
}
