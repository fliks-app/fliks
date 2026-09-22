import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { LiveTvSettingsComponent } from './live-tv-settings';

function createFixture(
  map: Record<string, string | null>,
  put: ReturnType<typeof vi.fn>,
): ComponentFixture<LiveTvSettingsComponent> {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: HttpClient,
        useValue: {
          get: () => of(map),
          put,
        } as unknown as HttpClient,
      },
    ],
  });
  const fixture = TestBed.createComponent(LiveTvSettingsComponent);
  fixture.detectChanges();
  return fixture;
}

async function ready(map: Record<string, string | null> = {}, put = vi.fn(() => of({ ok: true }))) {
  const fixture = createFixture(map, put);
  await fixture.whenStable();
  return { component: fixture.componentInstance, put };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const changesOf = (c: LiveTvSettingsComponent) =>
  (c as any).buildChanges() as Record<string, string | null>;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('LiveTvSettingsComponent - load', () => {
  it('loads existing values from the settings map', async () => {
    const { component } = await ready({
      livetv_guide_days_past: '5',
      livetv_guide_days_future: '10',
      livetv_segment_seconds: '4',
      livetv_timeshift_minutes: '20',
      livetv_channel_idle_seconds: '45',
      livetv_probe_seconds: '6',
      livetv_stale_stream_days: '14',
      livetv_slot_release_seconds: '30',
      livetv_fast_zap: 'true',
    });

    expect(component.guideDaysPast()).toBe(5);
    expect(component.guideDaysFuture()).toBe(10);
    expect(component.segmentSeconds()).toBe(4);
    expect(component.timeshiftMinutes()).toBe(20);
    expect(component.channelIdleSeconds()).toBe(45);
    expect(component.probeSeconds()).toBe(6);
    expect(component.staleStreamDays()).toBe(14);
    expect(component.slotReleaseSeconds()).toBe(30);
    expect(component.fastZap()).toBe('true');
  });

  it('falls back to the documented defaults for an absent key', async () => {
    const { component } = await ready({});

    expect(component.guideDaysPast()).toBe(2);
    expect(component.guideDaysFuture()).toBe(7);
    expect(component.segmentSeconds()).toBe(2);
    expect(component.timeshiftMinutes()).toBe(15);
    expect(component.channelIdleSeconds()).toBe(30);
    expect(component.probeSeconds()).toBe(3);
    expect(component.staleStreamDays()).toBe(7);
    expect(component.slotReleaseSeconds()).toBe(15);
    expect(component.fastZap()).toBe('auto');
  });
});

describe('LiveTvSettingsComponent - dirty tracking', () => {
  it('sends nothing when no field was touched', async () => {
    const { component } = await ready({});
    expect(changesOf(component)).toEqual({});
  });

  it('sends only the modified key, not the whole form', async () => {
    const { component } = await ready({});
    component.setInt(component.guideDaysPast, 'livetv_guide_days_past', 5);

    expect(changesOf(component)).toEqual({ livetv_guide_days_past: '5' });
  });

  it('calls the API with only the changed key on save', async () => {
    const put = vi.fn(() => of({ ok: true }));
    const { component } = await ready({ livetv_stale_stream_days: '7' }, put);
    component.setInt(component.probeSeconds, 'livetv_probe_seconds', 8);

    await component.save();

    expect(put).toHaveBeenCalledWith('/api/settings', { data: { livetv_probe_seconds: '8' } });
  });

  it('truncates a fraction and rejects a negative value instead of writing one the server would ignore', async () => {
    const { component } = await ready({});

    component.setInt(component.segmentSeconds, 'livetv_segment_seconds', 2.9);
    expect(component.segmentSeconds()).toBe(2);
    expect(changesOf(component)).toEqual({ livetv_segment_seconds: '2' });

    component.setInt(component.probeSeconds, 'livetv_probe_seconds', -1);
    expect(component.probeSeconds()).toBe(3);
    expect(changesOf(component)).not.toHaveProperty('livetv_probe_seconds');
  });
});

describe('LiveTvSettingsComponent - fast zap tri-state', () => {
  it('reads an absent override as "auto", not as false', async () => {
    const { component } = await ready({});
    expect(component.fastZap()).toBe('auto');
  });

  it('reads an explicit "false" override distinctly from "auto"', async () => {
    const { component } = await ready({ livetv_fast_zap: 'false' });
    expect(component.fastZap()).toBe('false');
    expect(component.fastZap()).not.toBe('auto');
  });

  it('sends null for "auto" so the override row is cleared, never stored as the string "false"', async () => {
    const { component } = await ready({ livetv_fast_zap: 'true' });
    expect(component.fastZap()).toBe('true');

    component.setFastZap('auto');

    // A boolean-typed field could only ever send 'true' or 'false' here, never
    // null, which is exactly the distinction "auto" needs to keep.
    expect(changesOf(component)).toEqual({ livetv_fast_zap: null });
  });

  it('sends the string "false" for an explicit forced-off choice', async () => {
    const { component } = await ready({});
    component.setFastZap('false');
    expect(changesOf(component)).toEqual({ livetv_fast_zap: 'false' });
  });
});
