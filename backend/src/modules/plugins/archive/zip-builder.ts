import { crc32, deflateRawSync } from 'zlib';

/**
 * Byte-level ZIP assembler for the guard spec suite. Several guards
 * (ZIP64, a data descriptor bit, duplicate central-directory records, a
 * lying declared size) cannot be produced by any real zip writer — this
 * builder writes the local header, file data, central directory and EOCD
 * by hand so a spec can corrupt exactly one field and leave the rest valid.
 */
export interface ZipEntrySpec {
  name: string;
  content: Buffer;
  /** Overrides the computed checksum — only a corruption fixture needs a wrong one. */
  declaredCrc32?: number;
  /** 0 = store, 8 = deflate. Default 0. */
  compressionMethod?: number;
  /** Default 0x0800 (UTF-8 flag) — set explicit bits to test the data-descriptor/encryption bits. */
  generalPurposeBitFlag?: number;
  /** Default 0 (no attributes). Set `(unixMode << 16) | dosBits` to test symlink/directory detection. */
  externalFileAttributes?: number;
  extraFields?: { id: number; data: Buffer }[];
  /** Lies about the size fields in both the local header and the central directory. */
  declaredUncompressedSize?: number;
  declaredCompressedSize?: number;
}

export interface ZipBuildOptions {
  /** Archive-level comment in the EOCD record. Default none. */
  archiveComment?: string;
  /** Indices into `entries` whose central-directory record is written a second time. */
  duplicateCentralDirectoryRecords?: number[];
  /** Raw bytes appended after the EOCD record — a second archive, or plain garbage. */
  trailingBytes?: Buffer;
  /** Override the EOCD's declared total-entries field independent of the actual record count. */
  declaredEntryCount?: number;
}

interface BuiltEntry {
  spec: ZipEntrySpec;
  offset: number;
  compressedData: Buffer;
  nameBuf: Buffer;
  extraBuf: Buffer;
}

function encodeExtraFields(fields: { id: number; data: Buffer }[]): Buffer {
  return Buffer.concat(
    fields.map(({ id, data }) => {
      const header = Buffer.alloc(4);
      header.writeUInt16LE(id, 0);
      header.writeUInt16LE(data.length, 2);
      return Buffer.concat([header, data]);
    }),
  );
}

/** A real checksum unless a spec pins one: a fixture may need a deliberately wrong value. */
function entryCrc(spec: ZipEntrySpec): number {
  return (spec.declaredCrc32 ?? crc32(spec.content)) >>> 0;
}

function buildLocalHeader(e: BuiltEntry): Buffer {
  const { spec, nameBuf, extraBuf, compressedData } = e;
  const compressionMethod = spec.compressionMethod ?? 0;
  const uncompressedSize = spec.declaredUncompressedSize ?? spec.content.length;
  const compressedSize = spec.declaredCompressedSize ?? compressedData.length;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(spec.generalPurposeBitFlag ?? 0x0800, 6);
  header.writeUInt16LE(compressionMethod, 8);
  header.writeUInt16LE(0, 10); // mod time
  header.writeUInt16LE(0x21, 12); // mod date — an arbitrary valid DOS date
  header.writeUInt32LE(entryCrc(spec), 14);
  header.writeUInt32LE(compressedSize >>> 0, 18);
  header.writeUInt32LE(uncompressedSize >>> 0, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(extraBuf.length, 28);
  return Buffer.concat([header, nameBuf, extraBuf]);
}

function buildCentralDirectoryRecord(e: BuiltEntry): Buffer {
  const { spec, nameBuf, extraBuf, compressedData, offset } = e;
  const compressionMethod = spec.compressionMethod ?? 0;
  const uncompressedSize = spec.declaredUncompressedSize ?? spec.content.length;
  const compressedSize = spec.declaredCompressedSize ?? compressedData.length;
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4); // version made by — Unix, spec 2.0
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(spec.generalPurposeBitFlag ?? 0x0800, 8);
  header.writeUInt16LE(compressionMethod, 10);
  header.writeUInt16LE(0, 12); // mod time
  header.writeUInt16LE(0x21, 14); // mod date
  header.writeUInt32LE(entryCrc(spec), 16);
  header.writeUInt32LE(compressedSize >>> 0, 20);
  header.writeUInt32LE(uncompressedSize >>> 0, 24);
  header.writeUInt16LE(nameBuf.length, 28);
  header.writeUInt16LE(extraBuf.length, 30);
  header.writeUInt16LE(0, 32); // file comment length
  header.writeUInt16LE(0, 34); // disk number start
  header.writeUInt16LE(0, 36); // internal file attributes
  header.writeUInt32LE((spec.externalFileAttributes ?? 0) >>> 0, 38);
  header.writeUInt32LE(offset >>> 0, 42);
  return Buffer.concat([header, nameBuf, extraBuf]);
}

/** Assemble a complete ZIP buffer from entry specs, byte by byte. */
export function buildZip(entries: ZipEntrySpec[], options: ZipBuildOptions = {}): Buffer {
  const built: BuiltEntry[] = [];
  const localParts: Buffer[] = [];
  let cursor = 0;

  for (const spec of entries) {
    const compressionMethod = spec.compressionMethod ?? 0;
    const compressedData = compressionMethod === 8 ? deflateRawSync(spec.content) : spec.content;
    const e: BuiltEntry = {
      spec,
      offset: cursor,
      compressedData,
      nameBuf: Buffer.from(spec.name, 'utf8'),
      extraBuf: encodeExtraFields(spec.extraFields ?? []),
    };
    const local = buildLocalHeader(e);
    localParts.push(local, compressedData);
    cursor += local.length + compressedData.length;
    built.push(e);
  }

  const centralParts: Buffer[] = built.map(buildCentralDirectoryRecord);
  for (const idx of options.duplicateCentralDirectoryRecords ?? []) {
    centralParts.push(buildCentralDirectoryRecord(built[idx]));
  }
  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = cursor;

  const commentBuf = Buffer.from(options.archiveComment ?? '', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where CD starts
  const entryCount = options.declaredEntryCount ?? centralParts.length;
  eocd.writeUInt16LE(entryCount, 8);
  eocd.writeUInt16LE(entryCount, 10);
  eocd.writeUInt32LE(centralDirectory.length >>> 0, 12);
  eocd.writeUInt32LE(centralDirectoryOffset >>> 0, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([
    ...localParts,
    centralDirectory,
    eocd,
    commentBuf,
    options.trailingBytes ?? Buffer.alloc(0),
  ]);
}
