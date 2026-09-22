import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { LiveTvChannelsComponent } from './live-tv-channels';
import { AdminChannel } from '../../../../core/services/api/livetv-api.service';

function channel(id: number, overrides: Partial<AdminChannel> = {}): AdminChannel {
  return {
    id,
    name: `Channel ${id}`,
    number: id,
    groupName: null,
    enabled: true,
    sourceId: 1,
    guideChannelId: null,
    guideMatchKind: null,
    guideShiftMinutes: 0,
    lastErrorAt: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

async function settle(fixture: ComponentFixture<unknown>) {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
}

function createFixture(get: ReturnType<typeof vi.fn>, patch: ReturnType<typeof vi.fn>) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      {
        provide: HttpClient,
        useValue: { get, patch } as unknown as HttpClient,
      },
    ],
  });
  const fixture = TestBed.createComponent(LiveTvChannelsComponent);
  fixture.detectChanges();
  return fixture;
}

describe('LiveTvChannelsComponent - bulk selection vs visible rows', () => {
  it('never targets a row that already left the result set', async () => {
    let channels = [channel(1), channel(2), channel(3), channel(4), channel(5)];
    const get = vi.fn((url: string) => {
      if (url === '/api/livetv/admin/sources') return of([]);
      if (url === '/api/livetv/admin/channels')
        return of({ items: channels, total: channels.length, groups: [] });
      throw new Error(`unexpected GET ${url}`);
    });
    const patch = vi.fn(() => of(undefined));
    const fixture = createFixture(get, patch);
    await settle(fixture);
    const component = fixture.componentInstance;

    for (const c of channels) component.toggleSelected(c.id);
    expect(component.selectedIds().size).toBe(5);

    // Channel 3 drops out of the next page, e.g. a filter change or another tab
    // disabling it while the "enabled" filter is active — the selection must follow.
    channels = channels.filter((c) => c.id !== 3);
    await component.load();

    expect(component.bulkTargetCount()).toBe(4);
    expect([...component.selectedIds()].sort()).toEqual([1, 2, 4, 5]);

    component.bulkEnable();
    await settle(fixture);

    expect(patch).toHaveBeenCalledWith(
      '/api/livetv/admin/channels/bulk',
      expect.objectContaining({ selection: { channelIds: [1, 2, 4, 5] } }),
    );
  });
});
