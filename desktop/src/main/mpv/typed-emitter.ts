import { EventEmitter } from 'node:events';

/** Event map: event name → the tuple of arguments its listeners receive. */
export type EventArgsMap = Record<string, unknown[]>;

/**
 * A minimal typed wrapper over Node's `EventEmitter`. `on`/`once`/`off`/`emit`
 * are constrained to a per-class event map, so both the event name and its
 * payload are checked at compile time (no string-literal drift, no untyped
 * payloads on the consumer side).
 */
export class TypedEmitter<T extends EventArgsMap> extends EventEmitter {
  on<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  once<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }
  off<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
  emit<K extends keyof T & string>(event: K, ...args: T[K]): boolean {
    return super.emit(event, ...args);
  }
}
