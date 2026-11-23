import type { Parse } from './ipc-handle';

export const none: Parse<[]> = () => [];

export function str(v: unknown, max = 4096): string {
  if (typeof v !== 'string' || v.length > max) throw new Error('invalid string');
  return v;
}

export function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('invalid number');
  return v;
}

export function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('invalid boolean');
  return v;
}

export function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('invalid object');
  return v as Record<string, unknown>;
}

/** `parse(v)` unless `v` is absent or null. */
export function nullable<T>(parse: (v: unknown) => T): (v: unknown) => T | null {
  return (v) => (v == null ? null : parse(v));
}

/** The raw first argument, for a handler that validates it itself. */
export const one: Parse<[unknown]> = (a) => [a[0]];
