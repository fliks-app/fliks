import * as fs from 'fs/promises';
import * as path from 'path';
import {
  isHttpSource,
  isManagedUpload,
  playlistDir,
  readLocalPlaylist,
  removeStoredPlaylist,
  storeUploadedPlaylist,
} from './livetv-playlist-file';

describe('livetv playlist files', () => {
  const written: string[] = [];

  afterAll(async () => {
    await Promise.all(written.map((f) => fs.rm(f, { force: true })));
  });

  it('tells a URL from a path', () => {
    expect(isHttpSource('http://host/get.php')).toBe(true);
    expect(isHttpSource('  https://host/x.m3u ')).toBe(true);
    expect(isHttpSource('/srv/playlists/mine.m3u')).toBe(false);
  });

  it('stores an upload under the data directory and reads it back', async () => {
    const location = await storeUploadedPlaylist(
      Buffer.from('#EXTM3U\n#EXTINF:-1,One\nhttp://h/1.ts\n'),
      'provider list.m3u',
    );
    written.push(location);

    expect(location.startsWith(playlistDir())).toBe(true);
    // The uploaded name is a hint; the uuid is what keeps two uploads apart.
    expect(path.basename(location)).toMatch(/^provider-list-[0-9a-f-]{36}\.m3u$/);
    const { body, version } = await readLocalPlaylist(location);
    expect(body).toContain('#EXTINF');
    expect(version).toMatch(/^\d/);
  });

  it('never lets two uploads of the same name collide', async () => {
    const a = await storeUploadedPlaylist(Buffer.from('#EXTM3U\n'), 'list.m3u');
    const b = await storeUploadedPlaylist(Buffer.from('#EXTM3U\n'), 'list.m3u');
    written.push(a, b);
    expect(a).not.toBe(b);
  });

  it('refuses to read a path it did not manage itself', async () => {
    await expect(readLocalPlaylist('/etc/passwd')).rejects.toThrow();
  });

  it('only ever deletes a file it stored itself', async () => {
    const outsider = path.join(playlistDir(), '..', 'not-ours.m3u');
    expect(isManagedUpload('/etc/passwd')).toBe(false);
    expect(isManagedUpload(outsider)).toBe(false);
    // A no-op rather than a throw: a source may hold a URL or a typed path.
    await expect(removeStoredPlaylist('/etc/passwd')).resolves.toBeUndefined();
  });

  it('removes a stored upload', async () => {
    const location = await storeUploadedPlaylist(Buffer.from('#EXTM3U\n'), 'gone.m3u');
    await removeStoredPlaylist(location);
    await expect(fs.stat(location)).rejects.toThrow();
  });
});
