import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import samples from '../../../../../server/fixtures/sse-events.json';
import { AppResumeService } from './app-resume.service';
import { AuthService } from './auth.service';
import { NetworkService } from './network.service';
import { ServerConfigService } from './server-config.service';
import { ServerVersionService } from './server-version.service';
import { SSE_STREAM_TYPES, SseService, type SseEvent } from './sse.service';
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
  it('refreshes the open page when the stream is lost and comes back', () => {
    const sse = setup();
    const refresh = vi.spyOn(TestBed.inject(AppResumeService), 'refresh');

    sse.ingest(frame({ type: 'sse.connected', connectionId: 'a' }));
    expect(refresh).not.toHaveBeenCalled();

    sse.ingest(frame({ type: 'sse.connected', connectionId: 'b' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('leaves the refresh of a resume to the resume itself', () => {
    const sse = setup();
    const refresh = vi.spyOn(TestBed.inject(AppResumeService), 'refresh');
    sse.ingest(frame({ type: 'sse.connected', connectionId: 'a' }));

    sse.resume();
    sse.ingest(frame({ type: 'sse.connected', connectionId: 'b' }));
    expect(refresh).not.toHaveBeenCalled();

    sse.ingest(frame({ type: 'sse.connected', connectionId: 'c' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('SseService against the server fixture', () => {
  // Typed to the bundled sample shape: every sample is a wire frame with a type.
  const frames = samples as SseEvent[];
  const fixtureTypes = new Set(frames.map((f) => f.type));
  // Fixture frames nothing subscribes to through `on()`: shown by the service itself, a signal, a table's own refresh list or a plugin prefix.
  const UNSUBSCRIBED = new Set([
    'acquisition.grab-best', 'acquisition.queue', 'download.progress', 'import.failed', 'karaoke.job_changed',
    'karaoke.model_changed', 'likes.changed', 'markers.season.completed', 'media.file_changed',
    'media.files.delete_failed', 'media.move.failed', 'metadata.started', 'notification', 'optimize.job_changed',
    'optimize.job_progress', 'optimize.queue_changed', 'orphan_import.completed', 'pairing.cancelled',
    'pairing.requested', 'party.closed', 'party.invited', 'party.members', 'party.message', 'party.programme',
    'party.proposals', 'party.reaction', 'party.settings', 'party.signal', 'party.starting', 'party.state',
    'party.updated', 'remote.command', 'remote.state', 'remote.stopped', 'rescan.failed', 'rescan.started',
    'seerr.import.started', 'session.changed', 'session.superseded', 'social.follow_accepted', 'social.followed',
    'sse.connected', 'subtitle.sync_cancelled', 'subtitle.sync_failed', 'subtitle.translation_progress',
    'task.progress', 'watch-history.import.started',
  ]);

  it('lists as subscribable only types the server sends', () => {
    expect(SSE_STREAM_TYPES.filter((t) => !fixtureTypes.has(t))).toEqual([]);
  });

  it('accounts for every fixture sample: a subscribed type or a stated unsubscribed one', () => {
    const subscribed = new Set<string>(SSE_STREAM_TYPES);
    const unaccounted = [...fixtureTypes].filter((t) => !subscribed.has(t) && !UNSUBSCRIBED.has(t));
    const both = [...fixtureTypes].filter((t) => subscribed.has(t) && UNSUBSCRIBED.has(t));

    expect(unaccounted).toEqual([]);
    expect(both).toEqual([]);
  });

  it('delivers every subscribable sample on the stream and no other', () => {
    const sse = setup();
    const seen = new Set<string>();
    sse.events.subscribe((e) => seen.add(e.type));

    for (const f of frames) sse.ingest(frame(f));

    expect([...seen].filter((t) => (SSE_STREAM_TYPES as readonly string[]).includes(t)).sort()).toEqual(
      [...SSE_STREAM_TYPES].sort(),
    );
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
