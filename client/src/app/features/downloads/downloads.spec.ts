import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { DownloadsComponent } from './downloads';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import type { DownloadTask } from '../../core/services/download-cache.service';
import { DownloadNotificationService } from '../../core/services/download-notification.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { AutoDownloadService } from '../../core/services/auto-download.service';

const task = (id: number, status: DownloadTask['status'], progress = 0): DownloadTask => ({
  id,
  mediaId: id,
  mediaFileId: id,
  quality: '1080p',
  status,
  progress,
  createdAt: '',
  media: { id, title: `Movie ${id}`, posterUrl: null, type: 'movie' },
});

function setup(initial: DownloadTask[]) {
  const tasks = signal(initial);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideTranslateService(),
      { provide: DownloadManagerService, useValue: { tasks, pauseDownload: vi.fn(), resumeDownload: vi.fn() } },
      { provide: DownloadNotificationService, useValue: { getFreeSpace: vi.fn().mockResolvedValue({ freeBytes: 5e9, totalBytes: 1e10 }) } },
      { provide: ConfirmationService, useValue: {} },
      { provide: ToastService, useValue: {} },
      { provide: AutoDownloadService, useValue: { KEEP_OPTIONS: [], enabled: false } },
    ],
  });
  const fixture = TestBed.createComponent(DownloadsComponent);
  return { tasks, fixture, component: fixture.componentInstance };
}

describe('DownloadsComponent', () => {
  it('derives its rows from the manager tasks, paused ones included', () => {
    const { component } = setup([task(1, 'paused', 30), task(2, 'downloading', 5), task(3, 'ready', 100)]);
    expect(component.items().map((t) => t.id)).toEqual([1, 2, 3]);
    expect(component.paused().map((t) => t.id)).toEqual([1]);
    expect(component.pausable().map((t) => t.id)).toEqual([2]);
  });

  it('renders a paused row with its resume button, and progress as it moves', async () => {
    const { tasks, fixture } = setup([task(1, 'paused', 30), task(2, 'downloading', 5)]);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Movie 1');
    expect(el.querySelector('[aria-label="downloads.resume"]')).not.toBeNull();
    expect(el.textContent).toContain('5%');
    tasks.set([task(1, 'paused', 30), task(2, 'downloading', 64)]);
    await fixture.whenStable();
    expect(el.textContent).toContain('64%');
  });

  it('lists in-flight tasks in a section, moving before paused, once per movie', async () => {
    const { fixture, component } = setup([task(1, 'paused', 30), task(2, 'downloading', 5), task(3, 'ready', 100)]);
    expect(component.inProgress().map((t) => t.id)).toEqual([2, 1]);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('section')).not.toBeNull();
    expect(el.textContent?.match(/Movie 2/g)).toHaveLength(1);
  });

  it('hides the section when nothing is in flight', async () => {
    const { fixture } = setup([task(3, 'ready', 100), task(4, 'failed')]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });

  it('renders a waiting_wifi row as a held bar with its label', async () => {
    const { fixture } = setup([task(1, 'waiting_wifi', 40)]);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('downloads.waiting_wifi');
    expect(el.querySelector('[aria-label="downloads.pause"]')).toBeNull();
  });

  it('shows free space, and summarises a show with in-flight episodes', async () => {
    const ep = (id: number, status: DownloadTask['status'], progress: number): DownloadTask => ({
      ...task(id, status, progress),
      mediaId: 9,
      episodeId: id,
      seasonNumber: 1,
      media: { id: 9, title: 'Show', posterUrl: null, type: 'series' },
    });
    const { fixture } = setup([ep(1, 'downloading', 20), ep(2, 'queued', 0), ep(3, 'ready', 100)]);
    await fixture.whenStable();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('downloads.total_free');
    expect(text).toContain('downloads.group_in_progress');
  });

  it('follows progress and status changes with no reload', () => {
    const { tasks, component } = setup([task(1, 'downloading', 5)]);
    tasks.set([task(1, 'downloading', 60)]);
    expect(component.items()[0].progress).toBe(60);
    tasks.set([task(1, 'ready', 100)]);
    expect(component.items()[0].status).toBe('ready');
    expect(component.pausable()).toEqual([]);
  });
});
