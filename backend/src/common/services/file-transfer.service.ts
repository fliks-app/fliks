import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export type TransferMethod = 'copy' | 'move';

const DEFAULT_COMPANION_EXTS =
  '.srt,.ass,.ssa,.vtt,.idx,.sub,.nfo,.jpg,.jpeg,.png,.webp';

/**
 * Filesystem helper shared by the disk-import flow and the torrent-completion
 * pipeline. Both pipelines copy a video into a library-managed destination
 * with renamed sidecar files; this service owns the OS-level concerns
 * (cross-filesystem EXDEV fallback, companion discovery, dest dir
 * creation) so the calling services only worry about the destination
 * computation.
 */
@Injectable()
export class FileTransferService {
  private readonly log = new Logger(FileTransferService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Materialise the file at `destPath`. `copy` always leaves the source
   * in place; `move` tries `rename` first (atomic on the same filesystem)
   * and falls back to copy + unlink on EXDEV (cross-device).
   * Parent directory is created if missing.
   */
  async transferFile(
    src: string,
    dest: string,
    method: TransferMethod,
  ): Promise<void> {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (method === 'copy') {
      await fsp.copyFile(src, dest);
      return;
    }
    try {
      await fsp.rename(src, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV') throw err;
      // Cross-device fallback: copy then unlink. If the copy succeeds but
      // the unlink fails we still consider the operation successful — the
      // dest is materialised and the orphan source is observable by the
      // admin (and a follow-up move would no-op).
      await fsp.copyFile(src, dest);
      try {
        await fsp.unlink(src);
      } catch (unlinkErr) {
        this.log.warn(
          `Source unlink failed after cross-device move: ${src} — ${(unlinkErr as Error).message}`,
        );
      }
    }
  }

  /**
   * Pick up sidecar files matching the original video's basename in `srcDir`
   * (subs, .nfo, posters …) and materialise them next to the renamed video
   * at `destDir`, preserving any language suffix (e.g. `name.fr.srt`).
   * Failures are logged at WARN level and skipped — never throw, never
   * block the parent import.
   */
  async transferCompanions(opts: {
    srcDir: string;
    destDir: string;
    sourceBaseName: string;
    newBaseName: string;
    method: TransferMethod;
    allowedExts: Set<string>;
    logTag?: string;
  }): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(opts.srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    const tag = opts.logTag ?? path.basename(opts.srcDir);
    const srcBase = opts.sourceBaseName.toLowerCase();

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!opts.allowedExts.has(ext)) continue;

      // Only pick up companions sharing the video's basename (case-insensitive).
      // This is what keeps "Movie.fr.srt" from being picked up alongside the
      // wrong video when the folder holds multiple titles.
      const stem = path.basename(entry.name, path.extname(entry.name));
      if (!stem.toLowerCase().startsWith(srcBase)) continue;

      // Preserve trailing language hint: "name.en.srt" / "name.en.forced.srt"
      // → keep the ".en[.forced]" suffix on top of newBaseName.
      const langMatch = stem.match(/\.([a-z]{2,3}(?:\.[a-z]+)?)$/i);
      const destName = langMatch
        ? `${opts.newBaseName}.${langMatch[1]}${ext}`
        : `${opts.newBaseName}${ext}`;

      const srcPath = path.join(opts.srcDir, entry.name);
      const destPath = path.join(opts.destDir, destName);
      try {
        await this.transferFile(srcPath, destPath, opts.method);
        this.log.log(`[${tag}] companion "${entry.name}" → "${destName}"`);
      } catch (e) {
        this.log.warn(
          `[${tag}] failed to ${opts.method} companion "${entry.name}": ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * Returns the configured companion-file extension allow-list, normalised
   * to lowercase with a leading dot. Falls back to a sensible default
   * covering common subtitle / poster / metadata sidecars.
   */
  async getCompanionExts(): Promise<Set<string>> {
    const rows: { value: string | null }[] = await this.dataSource.query(
      `SELECT value FROM app_settings WHERE key = 'companion_file_extensions' LIMIT 1`,
    );
    const raw = rows[0]?.value ?? DEFAULT_COMPANION_EXTS;
    return new Set(
      raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
        .map((e) => (e.startsWith('.') ? e : `.${e}`)),
    );
  }
}
