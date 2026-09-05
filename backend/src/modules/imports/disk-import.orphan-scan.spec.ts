import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { DiskImportService } from './disk-import.service';
import { NfoMetadataService } from './nfo-metadata.service';
import { NamingService } from '../scheduler/naming.service';
import { MediaType } from '../../common/enums';

const TVSHOW_NFO = `<tvshow><title>Northern Lights</title><year>2011</year>
<uniqueid type="tmdb">4242</uniqueid></tvshow>`;

async function buildTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-scan-'));
  const show = path.join(root, 'Northern Lights');
  await fs.mkdir(path.join(show, 'Season 01'), { recursive: true });
  await fs.writeFile(path.join(show, 'tvshow.nfo'), TVSHOW_NFO);
  for (const ep of ['S01E01', 'S01E02', 'S01E03']) {
    await fs.writeFile(
      path.join(show, 'Season 01', `Northern.Lights.${ep}.1080p.mkv`),
      'x',
    );
  }
  await fs.writeFile(
    path.join(show, 'Season 01', 'Northern.Lights.Special.1080p.mkv'),
    'x',
  );
  const movie = path.join(root, 'Quiet Harbour (2009)');
  await fs.mkdir(movie, { recursive: true });
  await fs.writeFile(path.join(movie, 'Quiet.Harbour.2009.1080p.mkv'), 'x');
  await fs.writeFile(path.join(root, 'stray.mkv'), 'x');
  return root;
}

function makeService(nfo: NfoMetadataService) {
  const naming = new NamingService(null as unknown as DataSource);
  return new DiskImportService(
    null as never, // mediaRepo
    null as never, // fileRepo
    null as never, // seasonRepo
    null as never, // episodeRepo
    null as never, // mediaService
    naming,
    null as never, // libraries
    null as never, // metadata
    nfo,
    null as never, // libraryIngest
    null as never, // postImportQueue
    null as never, // mediaServers
    { emit: jest.fn() } as never,
  );
}

describe('orphan scan', () => {
  let root: string;
  let nfo: NfoMetadataService;
  let readSpy: jest.SpyInstance;
  let service: DiskImportService;

  beforeAll(async () => {
    root = await buildTree();
    nfo = new NfoMetadataService();
    readSpy = jest.spyOn(nfo, 'readForVideoFile');
    service = makeService(nfo);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('groups episodes under one show, keeps movies per file, drops root files', async () => {
    const res = await service.previewOrphans({ path: root });

    expect(res.scannedFiles).toBe(6);
    expect(res.orphanCount).toBe(6);
    expect(res.looseFiles.map((f) => f.filename)).toEqual(['stray.mkv']);

    const series = res.groups.find((g) => g.mediaType === MediaType.SERIES);
    expect(series?.folderName).toBe('Northern Lights');
    // The special has no SxxEyy but is still a file of this show.
    expect(series?.files).toHaveLength(4);
    // Show-level .nfo wins over the filename guess for the whole group.
    expect(series?.guessTitle).toBe('Northern Lights');
    expect(series?.nfo?.tmdbId).toBe(4242);

    const movie = res.groups.find((g) => g.mediaType === MediaType.MOVIE);
    expect(movie?.files).toHaveLength(1);
    expect(movie?.guessYear).toBe(2009);

    // One probe per group, not per file — the probe is up to four reads.
    expect(readSpy).toHaveBeenCalledTimes(res.groups.length);
  });

  it('skips files whose inferred type the library does not accept', async () => {
    const res = await service.previewOrphans({
      path: root,
      mediaTypes: [MediaType.MOVIE],
    });

    expect(res.groups).toHaveLength(1);
    expect(res.groups[0].mediaType).toBe(MediaType.MOVIE);
    // The root-level file counts as an orphan too, it just isn't groupable.
    expect(res.orphanCount).toBe(2);
  });
});
