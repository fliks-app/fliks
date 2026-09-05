import dgram from 'node:dgram';

/** Minimal mDNS browser for `_googlecast._tcp.local`, enough to feed the Cast
 *  picker: PTR → instance, SRV → host + port, TXT → id / friendly name / model.
 *  Node has no stdlib mDNS and the protocol surface we need is one query type,
 *  so the packets are built and parsed here rather than pulling a resolver in. */

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_googlecast._tcp.local';

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

export interface DiscoveredDevice {
  id: string;
  name: string;
  modelName?: string;
  host: string;
  port: number;
}

interface Rr {
  name: string;
  type: number;
  start: number;
  length: number;
}

/** Read a DNS name at `offset`, following compression pointers. Returns the
 *  name and the offset just past the name *in the record stream* — a pointer
 *  consumes 2 bytes there however far it jumps. */
function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let next = offset;
  let jumped = false;
  // A malformed packet can point a name at itself; cap the walk.
  for (let guard = 0; guard < 128; guard++) {
    if (pos >= buf.length) break;
    const len = buf[pos];
    if (len === 0) {
      if (!jumped) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) next = pos + 2;
      jumped = true;
      pos = ptr;
      continue;
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
    if (!jumped) next = pos;
  }
  return [labels.join('.'), next];
}

export function parseRecords(buf: Buffer): Rr[] {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const rrCount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    [, pos] = readName(buf, pos);
    pos += 4;
  }
  const out: Rr[] = [];
  for (let i = 0; i < rrCount && pos + 10 <= buf.length; i++) {
    let name: string;
    [name, pos] = readName(buf, pos);
    if (pos + 10 > buf.length) break;
    const type = buf.readUInt16BE(pos);
    const length = buf.readUInt16BE(pos + 8);
    pos += 10;
    out.push({ name, type, start: pos, length });
    pos += length;
  }
  return out;
}

/** TXT rdata is a run of length-prefixed `key=value` strings. */
export function parseTxt(buf: Buffer, start: number, length: number): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = start;
  const end = Math.min(start + length, buf.length);
  while (pos < end) {
    const len = buf[pos];
    const text = buf.toString('utf8', pos + 1, Math.min(pos + 1 + len, end));
    const eq = text.indexOf('=');
    if (eq > 0) out[text.slice(0, eq)] = text.slice(eq + 1);
    pos += 1 + len;
  }
  return out;
}

export function buildQuery(): Buffer {
  const labels = SERVICE.split('.');
  const nameLen = labels.reduce((n, l) => n + 1 + l.length, 0) + 1;
  const buf = Buffer.alloc(12 + nameLen + 4);
  buf.writeUInt16BE(1, 4); // one question, everything else stays zero
  let pos = 12;
  for (const label of labels) {
    buf.writeUInt8(label.length, pos++);
    pos += buf.write(label, pos, 'utf8');
  }
  buf.writeUInt8(0, pos++);
  buf.writeUInt16BE(TYPE_PTR, pos);
  buf.writeUInt16BE(1, pos + 2);
  return buf;
}

interface Partial {
  host?: string;
  port?: number;
  target?: string;
  txt?: Record<string, string>;
}

/** Fold one response packet into the instance → partial-record map. Exported
 *  for the codec test: a device is only complete once SRV, TXT and A have all
 *  landed, which can take several packets. */
export function absorb(
  buf: Buffer,
  services: Map<string, Partial>,
  addresses: Map<string, string>,
): void {
  for (const rr of parseRecords(buf)) {
    if (rr.type === TYPE_PTR && rr.name === SERVICE) {
      const [instance] = readName(buf, rr.start);
      if (!services.has(instance)) services.set(instance, {});
    } else if (rr.type === TYPE_SRV) {
      // Only ever fill in an instance a googlecast PTR introduced: the socket
      // sees every mDNS conversation on the segment, and a printer's SRV would
      // otherwise register as a Cast device.
      const entry = services.get(rr.name);
      if (entry) {
        entry.port = buf.readUInt16BE(rr.start + 4);
        [entry.target] = readName(buf, rr.start + 6);
      }
    } else if (rr.type === TYPE_TXT) {
      const entry = services.get(rr.name);
      if (entry) entry.txt = parseTxt(buf, rr.start, rr.length);
    } else if (rr.type === TYPE_A && rr.length === 4) {
      addresses.set(rr.name, Array.from(buf.subarray(rr.start, rr.start + 4)).join('.'));
    }
  }
}

export function collect(
  services: Map<string, Partial>,
  addresses: Map<string, string>,
): DiscoveredDevice[] {
  const out: DiscoveredDevice[] = [];
  for (const [instance, entry] of services) {
    const host = entry.target ? addresses.get(entry.target) : undefined;
    if (!host || !entry.port) continue;
    const txt = entry.txt ?? {};
    out.push({
      // `id` is the device UUID, stable across reboots; the instance label is
      // the only fallback when a TXT record hasn't arrived yet.
      id: txt['id'] || instance,
      name: txt['fn'] || instance.split('.')[0],
      modelName: txt['md'],
      host,
      port: entry.port,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export class CastDiscovery {
  private socket: dgram.Socket | null = null;
  private readonly services = new Map<string, Partial>();
  private readonly addresses = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly onChange: (devices: DiscoveredDevice[]) => void;

  constructor(onChange: (devices: DiscoveredDevice[]) => void) {
    this.onChange = onChange;
  }

  start(): void {
    if (this.socket) return;
    // reuseAddr is what lets us share 5353 with the OS responder (mDNSResponder,
    // avahi); without it the bind fails on any machine already running one.
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (msg) => {
      const before = this.snapshot();
      absorb(msg, this.services, this.addresses);
      const after = this.snapshot();
      if (before !== after) this.onChange(this.devices());
    });
    socket.on('error', (err) => {
      console.warn('[cast] mdns socket error', err.message);
      this.stop();
    });
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDR);
      } catch (err) {
        console.warn('[cast] mdns membership failed', (err as Error).message);
      }
      this.query();
      // Chromecasts answer a query once; they don't heartbeat their presence at
      // a useful cadence, so re-ask to notice devices that appear or vanish.
      this.timer = setInterval(() => this.query(), 30_000);
    });
  }

  /** Re-send the PTR query. Called on every picker open so a device powered on
   *  since the last sweep shows up without waiting for the 30s tick. */
  query(): void {
    if (!this.socket) return;
    // ponytail: default multicast interface only; enumerate os.networkInterfaces()
    // and send per-interface if multi-homed hosts turn out to miss devices.
    this.socket.send(buildQuery(), MDNS_PORT, MDNS_ADDR, (err) => {
      if (err) console.warn('[cast] mdns query failed', err.message);
    });
  }

  devices(): DiscoveredDevice[] {
    return collect(this.services, this.addresses);
  }

  private snapshot(): string {
    return this.devices().map((d) => `${d.id}@${d.host}:${d.port}/${d.name}`).join('|');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }
}
