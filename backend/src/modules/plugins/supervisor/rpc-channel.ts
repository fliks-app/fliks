import type { Socket } from 'net';
import {
  encodeFrame,
  FrameReader,
  FrameTooLargeError,
  parseFrame,
  ProtocolViolationError,
  RpcTimeoutError,
  type Frame,
} from './wire';
import type { Req, Res, Note } from '../../../common/plugin-contract';

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export type RequestHandler = (method: string, payload: unknown) => Promise<unknown>;

function isReq(f: Frame): f is Req {
  return typeof (f as Req).i === 'number' && typeof (f as Req).m === 'string';
}
function isRes(f: Frame): f is Res {
  return typeof (f as Res).i === 'number' && !('m' in f);
}
function isNote(f: Frame): f is Note {
  return typeof (f as Note).m === 'string' && !('i' in f);
}

/** ENOENT is a structural signal (`fs.realpathSync` on a missing ingest path); everything
 *  else here matches message text from fliks-host.service.ts / plugin-host-binding.service.ts /
 *  plugin-supervisor.ts, which this file never edits — a wording change there falls back to 'ERR'. */
const HOST_ERROR_PATTERNS: readonly [RegExp, string][] = [
  [/^unknown host method /, 'ERR_NO_METHOD'],
  [/ timed out after \d+ms$/, 'ERR_TIMEOUT'],
  [/ has no active registration$/, 'ERR_NOT_FOUND'],
  [/^library\.ingest: no ingestRoots configured/, 'ERR_DENIED'],
  [/ is outside every configured ingest root$/, 'ERR_DENIED'],
  [/ is missing scope ".*" required for /, 'ERR_DENIED'],
  [/ exceeds the \d+ limit$/, 'ERR_VALIDATION'],
];

function classifyHostError(err: Error): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'ERR_NOT_FOUND';
  for (const [pattern, code] of HOST_ERROR_PATTERNS) {
    if (pattern.test(err.message)) return code;
  }
  return 'ERR';
}

/**
 * One newline-delimited JSON-RPC connection. Symmetric: either side may
 * `call()` the other; a frame fitting none of Req/Res/Note is a protocol violation, same as an unparsable line.
 */
export class RpcChannel {
  private reader = new FrameReader();
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private requestHandler: RequestHandler | null = null;
  private noteHandler: ((note: Note) => void) | null = null;
  private violationHandler: ((err: Error) => void) | null = null;
  private dropHandler: ((note: Note, err: FrameTooLargeError) => void) | null = null;
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onNote(handler: (note: Note) => void): void {
    this.noteHandler = handler;
  }

  /** Oversize frame or malformed line — the caller decides what to do (the supervisor SIGKILLs). */
  onViolation(handler: (err: Error) => void): void {
    this.violationHandler = handler;
  }

  private onData(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.reader.push(chunk);
    } catch (err) {
      this.violationHandler?.(err as Error);
      return;
    }
    for (const line of lines) {
      let frame: Frame;
      try {
        frame = parseFrame(line);
      } catch (err) {
        this.violationHandler?.(err as Error);
        return;
      }
      this.route(frame);
    }
  }

  private route(frame: Frame): void {
    if (isReq(frame)) {
      void this.handleRequest(frame);
    } else if (isRes(frame)) {
      this.handleResponse(frame);
    } else if (isNote(frame)) {
      this.noteHandler?.(frame);
    } else {
      this.violationHandler?.(new ProtocolViolationError('frame matches neither Req, Res nor Note'));
    }
  }

  private async handleRequest(req: Req): Promise<void> {
    if (!this.requestHandler) return;
    try {
      const r = await this.requestHandler(req.m, req.p);
      this.write({ i: req.i, r });
    } catch (err) {
      const e = err as Error;
      const code = e instanceof FrameTooLargeError ? 'ERR_RESULT_TOO_LARGE' : classifyHostError(e);
      // Bounded: the reason for refusing an oversize frame must not itself be one.
      this.write({ i: req.i, e: { c: code, m: e.message.slice(0, 4096) } });
    }
  }

  private handleResponse(res: Res): void {
    const call = this.pending.get(res.i);
    if (!call) return;
    this.pending.delete(res.i);
    clearTimeout(call.timer);
    if (res.e) call.reject(new Error(`${res.e.c}: ${res.e.m}`));
    else call.resolve(res.r);
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('connection closed'));
    }
    this.pending.clear();
  }

  /** Send a request and wait up to `deadlineMs` for a reply. Rejects on timeout or close. */
  call<T = unknown>(method: string, payload: unknown, deadlineMs: number): Promise<T> {
    const i = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(i);
        reject(new RpcTimeoutError(method, deadlineMs));
      }, deadlineMs);
      this.pending.set(i, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ i, m: method, p: payload });
      } catch (err) {
        this.pending.delete(i);
        clearTimeout(timer);
        throw err;
      }
    });
  }

  /** Fire-and-forget. Returns false when the socket is applying backpressure (caller must queue, not retry).
   *  A dropped note reports true: nothing was queued, so there is no drain to wait for. */
  sendNote(note: Note): boolean {
    try {
      return this.write(note);
    } catch (err) {
      if (!(err instanceof FrameTooLargeError)) throw err;
      this.dropHandler?.(note, err);
      return true;
    }
  }

  /** Notified when a note is refused at encode time, so the drop is counted where drops are counted. */
  onNoteDropped(cb: (note: Note, err: FrameTooLargeError) => void): void {
    this.dropHandler = cb;
  }

  destroy(): void {
    this.onClose();
    this.socket.destroy();
  }

  private write(frame: Frame): boolean {
    if (this.closed) return false;
    return this.socket.write(encodeFrame(frame));
  }
}
