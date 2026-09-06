/** Pre-detected content area inside the source frame. When set, sprite
 *  tiles carry the active picture only — no letterbox / pillarbox bars. */
export interface CropArea {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface ExtractArgs {
  inputPath: string;
  seekSeconds: number;
  outputPath: string;
  crop?: CropArea;
  thumbWidth: number;
  /** Source carries a PQ / HLG transfer — the tile needs tone-mapping. */
  hdr?: boolean;
}

/** One backend = one ffmpeg invocation strategy. The factory in `index.ts`
 *  picks the first available backend in priority order. Each backend
 *  decides whether it can handle a given crop request via {@link supports}. */
export interface ExtractorBackend {
  /** Short name for logs (e.g. `vaapi`, `qsv`, `sw`). */
  readonly name: string;
  /** Build a human-readable label including the device path (when relevant). */
  describe(): string;
  /** True when this backend can produce a frame for the given crop config. */
  supports(crop?: CropArea): boolean;
  /** Build the ffmpeg argv (no `ffmpeg` prefix) for one frame extract. */
  buildArgs(opts: ExtractArgs): string[];
}
