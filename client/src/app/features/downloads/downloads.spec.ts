import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { DownloadsComponent } from './downloads';
import { DownloadManagerService } from '../../core/services/download-manager.service';
import type { DownloadTask } from '../../core/services/download-cache.service';
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
      { provide: ConfirmationService, useValue: {} },
      { provide: ToastService, useValue: {} },
      { provide: AutoDownloadService, useValue: {} },
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

  it('follows progress and status changes with no reload', () => {
    const { tasks, component } = setup([task(1, 'downloading', 5)]);
    tasks.set([task(1, 'downloading', 60)]);
    expect(component.items()[0].progress).toBe(60);
    tasks.set([task(1, 'ready', 100)]);
    expect(component.items()[0].status).toBe('ready');
    expect(component.pausable()).toEqual([]);
  });
});
