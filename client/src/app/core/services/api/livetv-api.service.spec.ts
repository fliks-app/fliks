import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ServerVersionService } from '../server-version.service';
import { LiveTvApiService } from './livetv-api.service';

function setup(supports: boolean) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ServerVersionService, useValue: { supportsWhenKnown: async () => supports } },
    ],
  });
  return { api: TestBed.inject(LiveTvApiService), http: TestBed.inject(HttpTestingController) };
}

describe('LiveTvApiService.getChannelGroups', () => {
  it('reads the groups route of a server that serves it', async () => {
    const { api, http } = setup(true);
    const groups = api.getChannelGroups();
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne('/api/livetv/channels/groups').flush(['News', 'Sport']);
    expect(await groups).toEqual(['News', 'Sport']);
  });

  it('derives the groups from the channel list of an older server', async () => {
    const { api, http } = setup(false);
    const groups = api.getChannelGroups();
    await Promise.resolve();
    await Promise.resolve();
    http.expectNone('/api/livetv/channels/groups');
    http
      .expectOne('/api/livetv/channels')
      .flush([{ groupName: 'Sport' }, { groupName: null }, { groupName: 'News' }, { groupName: 'Sport' }]);
    expect(await groups).toEqual(['News', 'Sport']);
  });
});
