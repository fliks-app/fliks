import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { vi } from 'vitest';
import samples from '../../../../../server/fixtures/sse-events.json';
import { AppResumeService } from './app-resume.service';
import { AuthService } from './auth.service';
import { NetworkService } from './network.service';
import { ServerConfigService } from './server-config.service';
import { ServerVersionService } from './server-version.service';
import { SseService, type SseEvent } from './sse.service';
import { ToastService } from './toast.service';

function setup() {
  vi.spyOn(SseService.prototype, 'connect').mockResolvedValue();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ToastService, useValue: { info: () => {}, success: () => {}, error: () => {}, warning: () => {} } },
      { provide: ServerConfigService, useValue: { apiUrl: () => '' } },
      { provide: ServerVersionService, useValue: { supports: () => true, supportsWhenKnown: async () => true } },
      { provide: AuthService, useValue: { accessToken: () => null, isAuthenticated: () => false, sessionEpoch: () => 0 } },
      { provide: NetworkService, useValue: { isOnline: () => true, connectivityDoubt: () => 0 } },
    ],
  });
  return TestBed.inject(SseService);
}

const frame = (e: object) => JSON.stringify(e);

describe('SseService.events', () => {
  it('delivers two frames received back to back, each to its own subscriber call', () => {
    const sse = setup();
    const seen: string[] = [];
    sse.on('import.complete', 'queue.updated').subscribe((e) => seen.push(e.type));

    sse.ingest(frame({ type: 'import.complete', mediaId: 1 }));
    sse.ingest(frame({ type: 'queue.updated' }));

    expect(seen).toEqual(['import.complete', 'queue.updated']);
  });

  it('keeps high-frequency progress off the stream', () => {
    const sse = setup();
    const seen: string[] = [];
    sse.events.subscribe((e) => seen.push(e.type));

    sse.ingest(frame({ type: 'task.progress', command: 'c', current: 1, total: 2 }));

    expect(seen).toEqual([]);
  });

  it('drops a frame that does not parse', () => {
    const sse = setup();
    expect(() => sse.ingest('{not json')).not.toThrow();
  });
});

describe('SseService re-dial', () => {
  it('refreshes the open page on every connection after the first', () => {
    const sse = setup();
    const refresh = vi.spyOn(TestBed.inject(AppResumeService), 'refresh');

    sse.ingest(frame({ type: 'sse.connected', connectionId: 'a' }));
    expect(refresh).not.toHaveBeenCalled();

    sse.ingest(frame({ type: 'sse.connected', connectionId: 'b' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('SseService against the server fixture', () => {
  // Typed to the bundled sample shape: every sample is a wire frame with a type.
  const frames = samples as SseEvent[];

  it('routes every sample somewhere', () => {
    const sse = setup();
    const unrouted: string[] = [];
    const subjects: Observable<unknown>[] = [
      sse.events, sse.commands, sse.stopped, sse.sessionEvents, sse.notifications, sse.likeEvents, sse.partyEvents,
      sse.optimizeEvents, sse.karaokeEvents, sse.pairingEvents, sse.grabBestEvents, sse.queueEvents, sse.remoteStates,
      sse.subtitleSynced, sse.subtitleSyncFailed, sse.subtitleSyncCancelled,
    ];
    let delivered = 0;
    subjects.forEach((s) => s.subscribe(() => delivered++));
    // State frames land in signals and stores, not on a Subject.
    const state = new Set(['task.progress', 'download.progress', 'subtitle.translation_progress']);

    for (const f of frames) {
      const before = delivered;
      sse.ingest(frame(f));
      const reached = delivered > before || state.has(f.type) || f.type === 'sse.connected';
      if (!reached) unrouted.push(f.type);
    }

    expect(unrouted).toEqual([]);
  });

  it('keeps the acquisition frames under payload, where the consumers read them', () => {
    const sse = setup();
    const grab: SseEvent[] = [];
    const queue: SseEvent[] = [];
    sse.grabBestEvents.subscribe((e) => grab.push(e));
    sse.queueEvents.subscribe((e) => queue.push(e));
    for (const f of frames) sse.ingest(frame(f));

    expect(grab[0]?.['payload']).toMatchObject({ outcome: 'grabbed', scope: { mediaId: 1 } });
    expect(queue[0]?.['payload']).toMatchObject({ pluginId: 'p' });
  });
});
