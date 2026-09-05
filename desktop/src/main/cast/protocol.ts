import { EventEmitter } from 'node:events';
import tls from 'node:tls';

/** CASTV2 wire protocol: length-prefixed `CastMessage` protobuf frames over
 *  TLS/8009. The message has seven scalar fields, so it is encoded by hand
 *  rather than dragging a protobuf runtime into the bundle. */

export const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
export const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
export const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
export const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

export const PLATFORM_RECEIVER = 'receiver-0';

const HEARTBEAT_MS = 5_000;
/** Two missed PINGs: the device is gone (unplugged, off the network). */
const HEARTBEAT_TIMEOUT_MS = 15_000;

export interface CastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  data: string;
}

function writeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    bytes.push(byte);
  } while (v);
  return Buffer.from(bytes);
}

function readVarint(buf: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [value >>> 0, pos];
}

function stringField(tag: number, value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([tag]), writeVarint(body.length), body]);
}

/** Encode a CastMessage into a complete frame (4-byte big-endian length + body). */
export function encodeFrame(msg: CastMessage): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]), // protocol_version = CASTV2_1_0
    stringField(0x12, msg.sourceId),
    stringField(0x1a, msg.destinationId),
    stringField(0x22, msg.namespace),
    Buffer.from([0x28, 0x00]), // payload_type = STRING
    stringField(0x32, msg.data),
  ]);
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** Decode a CastMessage body (the frame without its length prefix). */
export function decodeMessage(body: Buffer): CastMessage {
  const msg: CastMessage = { sourceId: '', destinationId: '', namespace: '', data: '' };
  let pos = 0;
  while (pos < body.length) {
    const [tag, afterTag] = readVarint(body, pos);
    pos = afterTag;
    const wire = tag & 7;
    if (wire === 0) {
      [, pos] = readVarint(body, pos);
      continue;
    }
    if (wire !== 2) break; // castv2 uses varint + length-delimited only
    const [size, afterSize] = readVarint(body, pos);
    pos = afterSize;
    const value = body.subarray(pos, pos + size);
    pos += size;
    switch (tag >>> 3) {
      case 2: msg.sourceId = value.toString('utf8'); break;
      case 3: msg.destinationId = value.toString('utf8'); break;
      case 4: msg.namespace = value.toString('utf8'); break;
      case 6: msg.data = value.toString('utf8'); break;
    }
  }
  return msg;
}

/** Split a byte stream into CastMessage bodies, keeping any partial tail. */
export function splitFrames(buffer: Buffer): { messages: Buffer[]; rest: Buffer } {
  const messages: Buffer[] = [];
  let pos = 0;
  while (buffer.length - pos >= 4) {
    const size = buffer.readUInt32BE(pos);
    if (buffer.length - pos - 4 < size) break;
    messages.push(buffer.subarray(pos + 4, pos + 4 + size));
    pos += 4 + size;
  }
  return { messages, rest: buffer.subarray(pos) };
}

/**
 * One TLS connection to a Cast device. Owns the framing, the virtual
 * connection handshake and the heartbeat; everything above it (launching an
 * app, media control) speaks in JSON payloads on a namespace.
 *
 * Events: `message` (namespace, payload, sourceId), `close`.
 */
export class CastChannel extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private readonly connected = new Set<string>();
  private requestId = 1;

  readonly sourceId = `sender-${Math.random().toString(36).slice(2, 10)}`;

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Cast devices present a self-signed cert chained to a Google device CA
      // that no trust store carries; the LAN pairing is the trust boundary.
      const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        this.lastPong = Date.now();
        this.virtualConnect(PLATFORM_RECEIVER);
        this.startHeartbeat();
        resolve();
      });
      socket.setNoDelay(true);
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('error', (err) => {
        reject(err);
        this.close();
      });
      socket.on('close', () => this.close());
      this.socket = socket;
    });
  }

  /** Open a virtual connection to a destination — required before that
   *  destination will accept anything, the app transport included. */
  virtualConnect(destinationId: string): void {
    if (this.connected.has(destinationId)) return;
    this.connected.add(destinationId);
    this.send(NS_CONNECTION, destinationId, { type: 'CONNECT' });
  }

  send(namespace: string, destinationId: string, payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(
      encodeFrame({
        sourceId: this.sourceId,
        destinationId,
        namespace,
        data: JSON.stringify(payload),
      }),
    );
  }

  /** Send a request and resolve with the reply carrying the same requestId.
   *  Rejects on timeout so a caller never hangs on a receiver that went away. */
  request(
    namespace: string,
    destinationId: string,
    payload: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', listener);
        reject(new Error(`cast request timed out: ${String(payload['type'])}`));
      }, timeoutMs);
      const listener = (_ns: string, data: Record<string, unknown>) => {
        if (data['requestId'] !== requestId) return;
        clearTimeout(timer);
        this.off('message', listener);
        resolve(data);
      };
      this.on('message', listener);
      this.send(namespace, destinationId, { ...payload, requestId });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { messages, rest } = splitFrames(this.buffer);
    this.buffer = rest;
    for (const body of messages) {
      const msg = decodeMessage(body);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        continue; // binary payloads are not part of the surface we use
      }
      if (msg.namespace === NS_HEARTBEAT) {
        if (data['type'] === 'PONG') this.lastPong = Date.now();
        else if (data['type'] === 'PING') this.send(NS_HEARTBEAT, msg.sourceId, { type: 'PONG' });
        continue;
      }
      this.emit('message', msg.namespace, data, msg.sourceId);
    }
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT_MS) {
        console.warn('[cast] heartbeat lost, dropping the channel');
        this.close();
        return;
      }
      this.send(NS_HEARTBEAT, PLATFORM_RECEIVER, { type: 'PING' });
    }, HEARTBEAT_MS);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const socket = this.socket;
    this.socket = null;
    this.connected.clear();
    if (socket) {
      socket.removeAllListeners('close');
      socket.destroy();
      this.emit('close');
    }
  }

  get isOpen(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }
}
