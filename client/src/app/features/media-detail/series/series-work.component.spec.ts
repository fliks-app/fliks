import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { Media } from '../../../core/services/api/media.service';
import type { HandedEpisode } from '../media-detail-host';
import { BASE_MOVIE, fakeHost, videoSpecProviders } from '../video-work-test-setup';
import { SeriesWorkComponent } from './series-work.component';

type Page = SeriesWorkComponent & {
  episodeMode(): boolean;
  focusedEpisode(): { id: number } | null;
  focusedSeason(): { id: number } | null;
  activeFileId(): number | null;
  activeSeasonId(): number | null;
};

const SERIES = {
  ...BASE_MOVIE,
  id: 5,
  type: 'series',
  title: 'Placeholder',
  seasons: [{ id: 9, seasonNumber: 1, episodes: [{ id: 42, episodeNumber: 3, title: 'Pilot' }] }],
} as unknown as Media;
const STUB = { id: 5, type: 'series', title: '', monitored: true } as unknown as Media;
const SEED: HandedEpisode = { episodeId: 42, stillUrl: '/still.jpg', title: null, label: 'S01:E03' };

function render(media: Media, route: { episodeId?: string; season?: string }, seed: HandedEpisode | null = null) {
  const host = fakeHost({ episodeSeed: signal(seed) });
  TestBed.configureTestingModule({ providers: videoSpecProviders(host, { route: { id: '5', ...route } }) });
  TestBed.overrideComponent(SeriesWorkComponent, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(SeriesWorkComponent);
  fixture.componentRef.setInput('media', media);
  fixture.detectChanges();
  return { fixture, host, c: fixture.componentInstance as unknown as Page };
}

describe('SeriesWorkComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('episode seed from the card handoff', () => {
    it('focuses the handed episode on the first pass, before any season tree', () => {
      const { c, host } = render(STUB, { episodeId: '42' }, SEED);
      expect(c.episodeMode()).toBe(true);
      expect(c.focusedEpisode()?.id).toBe(42);
      expect(c.focusedSeason()).toBeNull();
      expect(host.notFound()).toBe(false);
    });

    it('ignores a seed that belongs to another episode', () => {
      const { c } = render(STUB, { episodeId: '43' }, SEED);
      expect(c.episodeMode()).toBe(false);
    });

    it('resolves the season once the real media lands, replacing the seed', () => {
      const { fixture, c, host } = render(STUB, { episodeId: '42' }, SEED);
      fixture.componentRef.setInput('media', SERIES);
      fixture.detectChanges();
      expect(c.focusedSeason()?.id).toBe(9);
      expect(c.focusedEpisode()?.id).toBe(42);
      expect(host.notFound()).toBe(false);
    });
  });

  describe('episode focus', () => {
    it('names the navbar after the series, the episode code and its title', () => {
      const { host } = render(SERIES, { episodeId: '42' });
      expect(host.navTitle()).toBe('Placeholder - S01:E03 - Pilot');
    });

    it('leaves the navbar title to the series on a series page', () => {
      const { host } = render(SERIES, {});
      expect(host.navTitle()).toBeNull();
    });

    it('flags an episode the tree does not hold as not found', () => {
      const { host } = render(SERIES, { episodeId: '999' });
      expect(host.notFound()).toBe(true);
    });
  });

  describe('seasons', () => {
    it('opens on the season named by `?season=`, once the playback state has had its say', async () => {
      const media = {
        ...SERIES,
        seasons: [
          { id: 9, seasonNumber: 1, episodes: [{ id: 1, hasFile: false }] },
          { id: 10, seasonNumber: 2, episodes: [{ id: 2, hasFile: false }] },
        ],
      } as unknown as Media;
      const { c } = render(media, { season: '2' });
      expect(c.activeSeasonId()).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(c.activeSeasonId()).toBe(10);
    });
  });

  describe('file selection', () => {
    const file = { id: 7, quality: '1080p', relativePath: 'a.mkv', size: 1, episodeId: 3 };

    it('keeps a selection that points at an episode file, until that file is gone', () => {
      const withFile = { ...SERIES, files: [file] } as Media;
      const { fixture, c } = render(withFile, {});
      c.selectedFileId.set(file.id);
      fixture.detectChanges();
      expect(c.selectedFileId()).toBe(file.id);

      fixture.componentRef.setInput('media', { ...withFile, files: [] });
      fixture.detectChanges();
      expect(c.selectedFileId()).toBeNull();
    });
  });
});
