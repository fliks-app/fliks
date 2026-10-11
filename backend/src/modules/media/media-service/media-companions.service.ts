import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fsp from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as nodePath from 'path';
import { Media } from '../entities/media.entity';
import { MediaFile } from '../entities/media-file.entity';
import { SubtitleFile } from '../../subtitles/entities/subtitle-file.entity';
import { MediaType, SubtitleProviderType } from '../../../common/enums';
import { SubtitlesService } from '../../subtitles/subtitles.service';
import { matchSubtitleVideo } from '../../subtitles/subtitle-matching';
import { resolveSubtitleAbsolutePath } from '../../subtitles/subtitle-path.util';
import { MAX_EDL_BYTES, edlPathFor, resolveEdlPath } from '../../streaming/edl/edl-sidecar';
import { parseEdl } from '../../streaming/edl/edl-parser';
import { parseSourceFps } from '../../streaming/transcoding/constants';
import { writeAtomically } from '../../../common/utils/atomic-file';
import { VIDEO_EXTS } from '../../../common/constants/video-extensions';

export type CompanionKind = 'subtitle' | 'edl' | 'nfo' | 'image' | 'other';

export interface CompanionFile {
  name: string;
  /** Relative to the media folder; the key a delete is addressed by. */
  relativePath: string;
  size: number;
  mtime: string;
  kind: CompanionKind;
  scope: 'file' | 'folder';
  subtitle: {
    id: number | null;
    language: string;
    forced: boolean;
    hearingImpaired: boolean;
  } | null;
  /** Other files of the media that also use this entry. */
  sharedWith: { fileId: number; name: string }[];
  /** A VobSub `.idx`/`.sub` pair: deleting one deletes the other. */
  hasPair: boolean;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const FOLDER_ART = new Set(['poster', 'folder', 'cover', 'movie', 'fanart', 'backdrop', 'clearlogo', 'logo']);

const norm = (p: string) => nodePath.posix.normalize(p.replace(/\\/g, '/'));

@Injectable()
export class MediaCompanionsService {
  private readonly log = new Logger(MediaCompanionsService.name);

  constructor(
    @InjectRepository(Media) private readonly mediaRepo: Repository<Media>,
    @InjectRepository(SubtitleFile) private readonly subRepo: Repository<SubtitleFile>,
    private readonly subtitles: SubtitlesService,
  ) {}

  private async regularFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async load(mediaId: number, fileId: number) {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId }, relations: ['files'] });
    if (!media) throw new NotFoundException(`Media #${mediaId} not found`);
    const file = media.files?.find((f) => f.id === fileId);
    if (!file) throw new NotFoundException(`File #${fileId} not found`);
    return { media, file };
  }

  private async collect(mediaId: number, fileId: number) {
    const { media, file } = await this.load(mediaId, fileId);
    const rows = (await this.subRepo.find({ where: { media: { id: mediaId } } })).filter(
      (s) => s.relativePath && s.providerType !== SubtitleProviderType.EMBEDDED,
    );
    return { media, file, rows, entries: media.path ? await this.scan(media, file, rows) : [] };
  }

  async list(mediaId: number, fileId: number): Promise<CompanionFile[]> {
    return (await this.collect(mediaId, fileId)).entries;
  }

  private async scan(media: Media, file: MediaFile, rows: SubtitleFile[]): Promise<CompanionFile[]> {
    const root = media.path!;
    const isSeries = media.type === MediaType.SERIES;
    const videoAbs = nodePath.resolve(root, file.relativePath);
    const { dir, name: stemRaw } = nodePath.parse(videoAbs);
    const stem = stemRaw.toLowerCase();
    const names = await this.regularFiles(dir);

    const stemOf = (f: MediaFile) => nodePath.parse(f.relativePath).name.toLowerCase();
    const dirOf = (f: MediaFile) => nodePath.dirname(nodePath.resolve(root, f.relativePath));
    const siblings = media.files.filter((f) => f.id !== file.id && dirOf(f) === dir && stemOf(f) === stem);
    const siblingIds = new Set(siblings.map((f) => f.id));
    const fileName = (id: number) => {
      const f = media.files.find((x) => x.id === id);
      return f ? nodePath.basename(f.relativePath) : `#${id}`;
    };

    const rowsByPath = new Map<string, SubtitleFile[]>();
    for (const r of rows) {
      const k = norm(r.relativePath!);
      rowsByPath.set(k, [...(rowsByPath.get(k) ?? []), r]);
    }

    const longerStems = names
      .filter((n) => VIDEO_EXTS.has(nodePath.extname(n).toLowerCase()))
      .map((n) => nodePath.parse(n).name.toLowerCase())
      .filter((s) => s.length > stem.length && s.startsWith(`${stem}.`));
    const claimed = (lower: string) => longerStems.some((s) => lower.startsWith(`${s}.`));

    const out = new Map<string, CompanionFile>();
    const add = async (
      absDir: string,
      name: string,
      scope: 'file' | 'folder',
      kind: CompanionKind,
      subRows: SubtitleFile[] = [],
    ) => {
      const abs = nodePath.join(absDir, name);
      const rel = norm(nodePath.relative(root, abs));
      if (out.has(rel)) return;
      let st;
      try {
        st = await fsp.lstat(abs);
      } catch {
        return;
      }
      if (!st.isFile()) return;
      const own = subRows.find((r) => r.mediaFileId === file.id) ?? subRows[0];
      const parsed = kind === 'subtitle' ? this.subtitles.parseSubtitleFilename(name) : null;
      const sharedIds = new Map<number, string>();
      if (scope === 'file') {
        for (const r of subRows) if (r.mediaFileId !== file.id) sharedIds.set(r.mediaFileId, fileName(r.mediaFileId));
        if (!subRows.length) for (const f of siblings) sharedIds.set(f.id, nodePath.basename(f.relativePath));
      }
      out.set(rel, {
        name,
        relativePath: rel,
        size: st.size,
        mtime: st.mtime.toISOString(),
        kind,
        scope,
        subtitle: own
          ? { id: own.id, language: own.language, forced: own.forced, hearingImpaired: own.hearingImpaired }
          : parsed
            ? { id: null, language: parsed.language, forced: parsed.forced, hearingImpaired: parsed.hearingImpaired }
            : null,
        sharedWith: [...sharedIds].map(([fileId, n]) => ({ fileId, name: n })),
        hasPair: false,
      });
    };

    // Folder-level files first: the names import reads, per media type.
    if (media.folderName) {
      const folderNfo: [string, string][] = isSeries
        ? [[root, 'tvshow.nfo'], [dir, 'tvshow.nfo'], [nodePath.dirname(dir), 'tvshow.nfo']]
        : [[dir, 'movie.nfo']];
      const artDirs = isSeries ? [root] : [dir];
      const inRoot = (d: string) => d === root || d.startsWith(root + nodePath.sep);
      for (const [d, want] of folderNfo) {
        if (!inRoot(d)) continue;
        const hit = (await this.regularFiles(d)).find((n) => n.toLowerCase() === want);
        if (hit) await add(d, hit, 'folder', 'nfo');
      }
      for (const d of artDirs) {
        for (const n of await this.regularFiles(d)) {
          const ext = nodePath.extname(n).toLowerCase();
          if (IMAGE_EXTS.has(ext) && FOLDER_ART.has(n.toLowerCase().slice(0, -ext.length))) await add(d, n, 'folder', 'image');
        }
      }
    }

    // Rows of this file (or of a version sharing its stem), wherever the name is.
    for (const [rel, rs] of rowsByPath) {
      if (!rs.some((r) => r.mediaFileId === file.id || siblingIds.has(r.mediaFileId))) continue;
      const abs = resolveSubtitleAbsolutePath(root, rel);
      if (abs) await add(nodePath.dirname(abs), nodePath.basename(abs), 'file', 'subtitle', rs);
    }

    const idx: string[] = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      const ext = nodePath.extname(lower);
      const base = lower.slice(0, lower.length - ext.length);
      if (VIDEO_EXTS.has(ext)) continue;
      if (ext === '.idx') {
        idx.push(name);
      } else if (lower === `${stem}.edl`) {
        await add(dir, name, 'file', 'edl');
      } else if (lower === `${stem}.nfo`) {
        await add(dir, name, 'file', 'nfo');
      } else if (!isSeries && IMAGE_EXTS.has(ext) && (base === `${stem}-poster` || base === `${stem}-fanart`)) {
        await add(dir, name, 'file', 'image');
      } else if (this.subtitles.parseSubtitleFilename(name)) {
        const rel = norm(nodePath.relative(root, nodePath.join(dir, name)));
        if (rowsByPath.has(rel) || claimed(lower)) continue;
        const hit = matchSubtitleVideo(name, dir, media.files, root, !!media.folderName);
        if (hit && (hit.id === file.id || siblingIds.has(hit.id))) await add(dir, name, 'file', 'subtitle');
      } else if (lower.startsWith(`${stem}.`) && !claimed(lower)) {
        await add(dir, name, 'file', 'other');
      }
    }

    const subOf = (rel: string) => [...out.values()].find((c) => norm(c.relativePath) === rel);
    for (const name of idx) {
      const rel = norm(nodePath.relative(root, nodePath.join(dir, name)));
      const base = rel.slice(0, -'.idx'.length).toLowerCase();
      const pair = [...out.values()].find(
        (c) => c.kind === 'subtitle' && c.relativePath.toLowerCase() === `${base}.sub`,
      );
      if (pair) {
        await add(dir, name, 'file', 'subtitle');
        const mine = subOf(rel);
        if (mine) {
          mine.subtitle = null;
          mine.sharedWith = pair.sharedWith;
          mine.hasPair = pair.hasPair = true;
        }
      } else if (name.toLowerCase().startsWith(`${stem}.`) && !claimed(name.toLowerCase())) {
        await add(dir, name, 'file', 'other');
      }
    }

    return [...out.values()].sort((a, b) =>
      a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'file' ? -1 : 1,
    );
  }

  /** The client path is only a lookup key into the server's own listing. */
  private async findListed(mediaId: number, fileId: number, relativePath: string) {
    const found = await this.collect(mediaId, fileId);
    const hit = found.entries.find((c) => c.relativePath === relativePath);
    if (!hit) throw new NotFoundException('Companion file not found');
    return { ...found, hit };
  }

  /** Opens a listed entry for download; O_NOFOLLOW + fstat close the lstat-to-open swap window. */
  async openForDownload(mediaId: number, fileId: number, relativePath: string) {
    const { media, hit } = await this.findListed(mediaId, fileId, relativePath);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(nodePath.join(media.path!, hit.relativePath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      throw new NotFoundException('Companion file not found');
    }
    const st = await handle.stat();
    if (!st.isFile()) {
      await handle.close();
      throw new NotFoundException('Companion file not found');
    }
    return { name: hit.name, size: st.size, stream: handle.createReadStream() };
  }

  /** Deletes one entry of the server's own listing. */
  async remove(mediaId: number, fileId: number, relativePath: string, userId?: number): Promise<void> {
    const { media, rows, entries, hit } = await this.findListed(mediaId, fileId, relativePath);
    const pairBase = (p: string) => p.toLowerCase().replace(/\.(idx|sub)$/, '');
    const targets = hit.hasPair
      ? entries.filter((c) => c.hasPair && pairBase(c.relativePath) === pairBase(hit.relativePath))
      : [hit];
    for (const t of targets) {
      const tracked = rows.filter((r) => norm(r.relativePath!) === t.relativePath);
      if (tracked.length) {
        for (const r of tracked) await this.subtitles.deleteSubtitle(r.id);
      } else {
        await fsp.unlink(nodePath.join(media.path!, t.relativePath));
      }
    }
    this.log.log(`User ${userId ?? '?'} deleted companion file "${hit.relativePath}" (media #${mediaId}, file #${fileId}, ${hit.kind})`);
  }

  /** Validates an uploaded EDL like the playback reader does, then writes it beside the video. */
  async importEdl(mediaId: number, fileId: number, buffer: Buffer, replace: boolean, userId?: number) {
    if (buffer.length > MAX_EDL_BYTES) throw new BadRequestException('file_info.import_err_too_large');
    if (buffer.includes(0)) throw new BadRequestException('file_info.import_err_binary');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new BadRequestException('file_info.import_err_encoding');
    }
    const { media, file } = await this.load(mediaId, fileId);
    if (!media.path) throw new BadRequestException('file_info.import_err_no_folder');
    const video = nodePath.resolve(media.path, file.relativePath);
    const parsed = parseEdl(text, parseSourceFps(file.streamInfo?.video?.[0]?.frameRate));
    if (!parsed.ranges.length) throw new BadRequestException('file_info.import_err_no_ranges');

    const existing = await resolveEdlPath(video);
    if (existing && !replace) {
      throw new ConflictException({ code: 'EDL_EXISTS', message: 'file_info.import_edl_exists' });
    }
    const target = existing ?? edlPathFor(video);
    // 'wx' claims a new name so a racing first import gets the 409 instead of overwriting.
    if (!existing) {
      try {
        await (await fsp.open(target, 'wx')).close();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        throw new ConflictException({ code: 'EDL_EXISTS', message: 'file_info.import_edl_exists' });
      }
    }
    try {
      await writeAtomically(target, (tmp) => fsp.writeFile(tmp, buffer));
    } catch (err) {
      if (!existing) await fsp.rm(target, { force: true }).catch(() => {});
      throw err;
    }
    this.log.log(`User ${userId ?? '?'} imported EDL "${target}" (media #${mediaId}, file #${fileId}, ${parsed.ranges.length} range(s))`);
    return { ranges: parsed.ranges.length, rejected: parsed.rejected };
  }
}
