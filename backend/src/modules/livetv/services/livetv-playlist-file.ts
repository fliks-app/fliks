import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDataDir } from '../../../common/constants/paths';

/** Uploaded playlists live with the data, not the cache: nothing can re-fetch them. */
export function playlistDir(): string {
  return path.join(getDataDir(), 'livetv', 'playlists');
}

export function isHttpSource(location: string): boolean {
  return /^https?:\/\//i.test(location.trim());
}

/** A stored upload, as opposed to a path an administrator typed. */
export function isManagedUpload(location: string): boolean {
  return !isHttpSource(location) && path.resolve(location).startsWith(playlistDir());
}

export async function storeUploadedPlaylist(
  contents: Buffer,
  originalName: string,
): Promise<string> {
  const dir = playlistDir();
  await fs.mkdir(dir, { recursive: true });
  // The name is only a hint for a human reading the directory; the uuid is the
  // identity, so a second upload of "playlist.m3u" never clobbers the first.
  const stem = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .slice(0, 40);
  const target = path.join(dir, `${stem || 'playlist'}-${randomUUID()}.m3u`);
  await fs.writeFile(target, contents);
  return target;
}

export async function removeStoredPlaylist(location: string): Promise<void> {
  if (!isManagedUpload(location)) return;
  await fs.rm(location, { force: true });
}

export interface LocalPlaylist {
  body: string;
  /** The file's mtime, used the way an ETag is used for a URL. */
  version: string;
}

export async function readLocalPlaylist(location: string): Promise<LocalPlaylist> {
  const [body, stat] = await Promise.all([
    fs.readFile(location, 'utf8'),
    fs.stat(location),
  ]);
  return { body, version: String(stat.mtimeMs) };
}
