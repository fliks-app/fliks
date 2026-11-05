import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Media } from '../../../core/services/api/media.service';
import { BASE_MOVIE, fakeHost, videoSpecProviders } from '../video-work-test-setup';
import { MovieWorkComponent } from './movie-work.component';

const UNIDENTIFIED_MOVIE: Media = { ...BASE_MOVIE, tmdbId: null, tvdbId: null, imdbId: null };
const FILE = { id: 7, quality: '1080p', relativePath: 'a.mkv', size: 1 };

function render(media: Media, services: Parameters<typeof videoSpecProviders>[1] = {}) {
  const host = fakeHost();
  TestBed.configureTestingModule({ providers: videoSpecProviders(host, services) });
  TestBed.overrideComponent(MovieWorkComponent, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(MovieWorkComponent);
  fixture.componentRef.setInput('media', media);
  fixture.detectChanges();
  return { fixture, host, c: fixture.componentInstance as unknown as MovieWorkComponent & { activeFileId(): number | null } };
}

describe('MovieWorkComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('provider-derived rows', () => {
    it('never fetches similar titles for an unidentified title', () => {
      const getSimilar = vi.fn(async () => []);
      render(UNIDENTIFIED_MOVIE, { media: { getSimilar } });
      expect(getSimilar).not.toHaveBeenCalled();
    });

    it('fetches similar titles for an identified movie', () => {
      const getSimilar = vi.fn(async () => []);
      render(BASE_MOVIE, { media: { getSimilar } });
      expect(getSimilar).toHaveBeenCalledWith(BASE_MOVIE.id);
    });

    it('waits for the full title: a list handover carries no cast to fetch', () => {
      const getCast = vi.fn(async () => []);
      const host = fakeHost({ fullLoaded: signal(false) });
      TestBed.configureTestingModule({ providers: videoSpecProviders(host, { media: { getCast } }) });
      TestBed.overrideComponent(MovieWorkComponent, { set: { template: '', imports: [] } });
      const fixture = TestBed.createComponent(MovieWorkComponent);
      fixture.componentRef.setInput('media', BASE_MOVIE);
      fixture.detectChanges();
      expect(getCast).not.toHaveBeenCalled();
    });
  });

  describe('file selection', () => {
    it('clears the selection when the selected file is gone', () => {
      const { fixture, c } = render({ ...BASE_MOVIE, files: [FILE] });
      expect(c.selectedFileId()).toBe(FILE.id);

      fixture.componentRef.setInput('media', { ...BASE_MOVIE, files: [] });
      fixture.detectChanges();
      expect(c.selectedFileId()).toBeNull();
      expect(c.activeFileId()).toBeNull();
    });
  });

  describe('change quality', () => {
    const request = { mediaFileId: 7, quality: '720p', unwatchedOnly: false };
    const download = (c: object) => (c as { onDownload(ev: typeof request): Promise<void> }).onDownload(request);

    it('deletes the downloaded copy, then creates the new quality', async () => {
      const calls: string[] = [];
      const ready = { id: 5, mediaFileId: 7, quality: '1080p', status: 'ready', progress: 100 };
      const manager = {
        tasks: signal([ready]),
        deleteDownload: vi.fn(async () => void calls.push('delete')),
        createDownload: vi.fn(async () => void calls.push('create')),
      };
      const { c } = render(BASE_MOVIE, { downloadManager: manager });
      await download(c);

      expect(manager.deleteDownload).toHaveBeenCalledWith(ready);
      expect(calls).toEqual(['delete', 'create']);
    });

    it('only creates when nothing is downloaded', async () => {
      const manager = { tasks: signal([]), deleteDownload: vi.fn(), createDownload: vi.fn(async () => {}) };
      const { c } = render(BASE_MOVIE, { downloadManager: manager });
      await download(c);

      expect(manager.deleteDownload).not.toHaveBeenCalled();
      expect(manager.createDownload).toHaveBeenCalled();
    });
  });
});
