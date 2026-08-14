import { MAX_FRAME_BYTES, type Req, type Res, type Note } from '../../../common/plugin-contract';

export type Frame = Req | Res | Note;

/** Raised on any wire-level breach: oversize frame or unparsable line. Fatal to the connection. */
export class ProtocolViolationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProtocolViolationError';
  }
}

/** Raised when a frame we're about to send would breach MAX_FRAME_BYTES — our own fault, not the peer's. */
export class FrameTooLargeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'FrameTooLargeError';
  }
}

/** One JSON object per line. Refuses past MAX_FRAME_BYTES rather than breaching the peer's reader. */
export function encodeFrame(frame: Frame): Buffer {
  const json = JSON.stringify(frame);
  const size = Buffer.byteLength(json, 'utf8');
  if (size > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(`frame of ${size} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`);
  }
  return Buffer.from(json + '\n', 'utf8');
}

/**
 * Buffers raw bytes into newline-delimited lines; a partial line waits for
 * more data. Any line, complete or still growing, past MAX_FRAME_BYTES throws — bounded even before a newline arrives.
 */
export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    const combined = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    while (true) {
      const nl = combined.indexOf(0x0a, start);
      if (nl === -1) break;
      if (nl - start > MAX_FRAME_BYTES) {
        throw new ProtocolViolationError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
      }
      lines.push(combined.subarray(start, nl).toString('utf8'));
      start = nl + 1;
    }
    const rest = combined.subarray(start);
    if (rest.length > MAX_FRAME_BYTES) {
      throw new ProtocolViolationError(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    this.pending = rest;
    return lines;
  }
}

export function parseFrame(line: string): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolViolationError('malformed JSON line');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolViolationError('frame is not a JSON object');
  }
  return parsed as Frame;
}
