export type CompanionImportType = 'subtitle' | 'edl';

const rule = (exts: readonly string[], maxBytes: number, mime = '') => ({
  exts,
  maxBytes,
  accept: exts.join(',') + mime,
});

/** Per-type picker filter and size cap; the caps mirror the server's (5 MiB, 1 MiB). */
export const COMPANION_IMPORT = {
  subtitle: rule(['.srt', '.ass', '.ssa', '.vtt'], 5 * 1024 * 1024, ',text/plain'),
  edl: rule(['.edl'], 1024 * 1024),
} as const satisfies Record<CompanionImportType, unknown>;
