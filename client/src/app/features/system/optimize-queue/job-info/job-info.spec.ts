import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { OptimizeService } from '../../../../core/services/api/optimize.service';
import type { OptimizeJob, OptimizeJobDetail } from '../../../../core/models/optimize';
import { OptimizeJobInfoComponent } from './job-info';

const detail: OptimizeJobDetail = {
  diff: {
    changes: [{ type: 'drop', kind: 'audio', streamIndex: 2, language: 'ita', reason: 'language' }],
    warnings: [],
  },
  source: {
    video: [{ streamIndex: 0, codec: 'h264', width: 1920, height: 1080, bitDepth: 8 }],
    audio: [
      { streamIndex: 1, codec: 'ac3', language: 'fre', channels: 6 },
      { streamIndex: 2, codec: 'ac3', language: 'ita', channels: 2 },
    ],
    subtitles: [],
    formatName: 'matroska,webm',
  },
  output: {
    video: [{ streamIndex: 0, codec: 'hevc', width: 1920, height: 1080, bitDepth: 10 }],
    audio: [{ streamIndex: 1, codec: 'ac3', language: 'fre', channels: 6 }],
    subtitles: [],
    formatName: 'matroska,webm',
  },
  doneLevel: 'reencode',
  copyReason: null,
  cpuFallback: false,
  sampledSavingsPct: 30.4,
  savingsPct: -22.2,
  ssim: 0.98765,
  startedAt: '2026-11-26T10:00:00.000Z',
  encodedAt: '2026-11-26T10:30:00.000Z',
  finishedAt: '2026-11-26T10:31:00.000Z',
};

describe('OptimizeJobInfoComponent', () => {
  it('numbers changed tracks among their kind and compares the probes', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
        { provide: OptimizeService, useValue: { job: () => Promise.resolve(detail) } },
      ],
    });
    const f = TestBed.createComponent(OptimizeJobInfoComponent);
    f.componentRef.setInput('job', {
      id: 1,
      state: 'done',
      level: 'reencode',
      inSize: 1000,
      outSize: 600,
    } as OptimizeJob);
    await f.whenStable();
    const c = f.componentInstance;
    expect(c.changes()).toEqual([
      {
        group: 'audio',
        items: [
          {
            group: 'audio',
            key: 'settings.optimize.change.drop_language',
            params: { n: 2, language: 'ita' },
          },
        ],
      },
    ]);
    expect(c.saved()).toEqual({ bytes: 400, pct: 40 });
    expect(c.encodeTime()).toBe('30m 0s');
    expect(c.before()?.video).toBe('H264 · 1920×1080 · 8 bit');
    expect(c.after()?.audio.length).toBe(1);
    expect(c.after()?.container).toBe('MATROSKA');
    expect(c.videoSize()).toEqual({ real: '+22 %', test: '\u221230 %' });
    expect(c.fidelity()).toMatch(/^98[.,]8 %$/);
  });
});
