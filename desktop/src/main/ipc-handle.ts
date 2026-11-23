import { ipcMain, type IpcMainInvokeEvent } from 'electron';

/** Turns a channel's raw renderer arguments into the typed tuple its handler takes, or throws. */
export type Parse<A extends unknown[]> = (args: unknown[], e: IpcMainInvokeEvent) => A;

/** The one way to register a renderer→main channel: a channel without a parser does not compile,
 *  and the handler only ever sees what the parser rebuilt. */
export function handle<A extends unknown[], R>(
  channel: string,
  parse: Parse<A>,
  fn: (...args: A) => R | Promise<R>,
): void {
  ipcMain.handle(channel, (e, ...raw) => fn(...parse(raw, e)));
}

/** `handle` for a channel with one argument. */
export function handle1<A, R>(
  channel: string,
  parse: (v: unknown, e: IpcMainInvokeEvent) => A,
  fn: (a: A) => R | Promise<R>,
): void {
  handle(channel, (a, e): [A] => [parse(a[0], e)], fn);
}

export { none, one, str, num, bool, obj, nullable } from './ipc-parse.ts';
