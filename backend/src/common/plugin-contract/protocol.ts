/**
 * Wire protocol for the two unix sockets between core and a `process`
 * plugin: newline-delimited JSON, one object per line.
 *
 * This directory is a standalone island: it imports nothing from
 * `backend/src` outside itself (no NestJS, no TypeORM, no entity class),
 * because the plugin repo compiles this same source as its contract.
 */

/** A request frame. `i` pairs it with its `Res`; `m` is the dotted method name. */
export interface Req {
  i: number;
  m: string;
  p?: unknown;
}

/** The reply to a `Req` with the same `i`. Exactly one of `r`/`e` is present. */
export interface Res {
  i: number;
  r?: unknown;
  e?: { c: string; m: string };
}

/** A fire-and-forget frame: no `i`, no reply is ever sent for it. */
export type Note<P = unknown> = { m: string; p?: P };

/** Per-frame size ceiling. An oversize frame is a protocol violation and SIGKILLs the plugin. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Checked for exact equality at catalog, install and `hello` — never a
 * range. Within one value the method set is additive-only; any removal
 * or semantic change bumps it.
 */
export const PLUGIN_API_VERSION = 0;
