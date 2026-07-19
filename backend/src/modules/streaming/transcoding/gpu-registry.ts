import * as fs from 'fs';
import * as path from 'path';

/** Physical GPU classification for the admin device picker. */
export type GpuKind = 'igpu' | 'dgpu' | 'nvidia' | 'amd' | 'unknown';

export interface GpuInfo {
  /** DRI render node, e.g. `/dev/dri/renderD128`. The value stored as the
   *  `streaming_gpu_render_node` setting and threaded into the device init. */
  renderNode: string;
  /** DRM card node (`card1`), when resolvable. */
  card?: string;
  /** Lowercased vendor name (`intel` / `nvidia` / `amd`) or the raw id. */
  vendor: string;
  vendorId: string;
  deviceId: string;
  /** PCI slot (`0000:00:02.0`), when resolvable. */
  pciSlot?: string;
  kind: GpuKind;
  /** Human label for the dropdown. */
  label: string;
}

const VENDOR_NAMES: Record<string, string> = {
  '0x8086': 'intel',
  '0x10de': 'nvidia',
  '0x1002': 'amd',
};

/** A few well-known Intel device ids so the label reads better than a bare
 *  PCI id. Not exhaustive — anything unlisted falls back to the vendor + id. */
const KNOWN_MODELS: Record<string, string> = {
  '0xa7a8': 'Raptor Lake UHD Graphics',
  '0x5693': 'Arc A370M',
};

function readTrimmed(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

function classify(vendor: string, isBootVga: boolean): GpuKind {
  if (vendor === 'nvidia') return 'nvidia';
  if (vendor === 'amd') return 'amd';
  if (vendor === 'intel') return isBootVga ? 'igpu' : 'dgpu';
  return 'unknown';
}

function kindLabel(kind: GpuKind): string {
  switch (kind) {
    case 'igpu':
      return 'iGPU';
    case 'dgpu':
      return 'dGPU';
    case 'nvidia':
      return 'NVIDIA';
    case 'amd':
      return 'AMD';
    default:
      return 'GPU';
  }
}

/** Enumerate the host's DRI render nodes and identify each GPU from sysfs.
 *  Returns `[]` on non-Linux hosts (no `/dev/dri`) or when nothing is
 *  readable — callers treat an empty list as "single/opaque device, hide the
 *  picker". Cheap (a handful of tiny sysfs reads); call once and cache. */
export function enumerateGpus(): GpuInfo[] {
  const driDir = '/dev/dri';
  let entries: string[];
  try {
    entries = fs.readdirSync(driDir);
  } catch {
    return [];
  }
  const out: GpuInfo[] = [];
  for (const name of entries.sort()) {
    if (!/^renderD\d+$/.test(name)) continue;
    const renderNode = path.join(driDir, name);
    const sys = `/sys/class/drm/${name}/device`;
    const vendorId = readTrimmed(`${sys}/vendor`) ?? '';
    const deviceId = readTrimmed(`${sys}/device`) ?? '';
    const bootVga = readTrimmed(`${sys}/boot_vga`) === '1';
    let pciSlot: string | undefined;
    try {
      pciSlot = path.basename(fs.realpathSync(sys));
    } catch {
      pciSlot = undefined;
    }
    let card: string | undefined;
    try {
      card = fs
        .readdirSync(`/sys/class/drm/${name}/device/drm`)
        .find((c) => /^card\d+$/.test(c));
    } catch {
      card = undefined;
    }
    const vendor = VENDOR_NAMES[vendorId] ?? vendorId ?? 'unknown';
    const kind = classify(vendor, bootVga);
    const model = KNOWN_MODELS[deviceId];
    const vendorLabel =
      vendor === 'intel'
        ? 'Intel'
        : vendor === 'nvidia'
          ? 'NVIDIA'
          : vendor === 'amd'
            ? 'AMD'
            : vendor;
    const label = model
      ? `${vendorLabel} ${model} · ${kindLabel(kind)} · ${name}`
      : `${vendorLabel} ${kindLabel(kind)} · ${name} (${vendorId || '?'}:${deviceId || '?'})`;
    out.push({
      renderNode,
      card,
      vendor,
      vendorId,
      deviceId,
      pciSlot,
      kind,
      label,
    });
  }
  return out;
}
