import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PartyApiService } from '../api/party-api.service';
import { ServerConfigService } from '../server-config.service';
import { EmojiDataService } from './emoji-data.service';
import { ReactionsService } from './reactions.service';

function service(): ReactionsService {
  TestBed.configureTestingModule({
    providers: [
      { provide: PartyApiService, useValue: {} },
      { provide: EmojiDataService, useValue: { known: () => new Set<string>() } },
      { provide: ServerConfigService, useValue: {} },
    ],
  });
  return TestBed.inject(ReactionsService);
}

describe('ReactionsService keep-open default', () => {
  beforeEach(() => localStorage.removeItem('party.reactionKeepOpen'));

  it('is on when nothing is stored', () => {
    expect(service().keepOpen()).toBe(true);
  });

  it('keeps an explicit off', () => {
    localStorage.setItem('party.reactionKeepOpen', '0');
    expect(service().keepOpen()).toBe(false);
  });
});
