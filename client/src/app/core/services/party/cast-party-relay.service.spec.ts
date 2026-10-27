import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CastService } from '../cast.service';
import { CastPartyRelayService } from './cast-party-relay.service';
import { PartyService, type PartyFloated } from './party.service';
import { ReactionsService } from './reactions.service';

function setup(over: { connected?: boolean; reactions?: boolean; partyReactions?: boolean; chat?: boolean } = {}) {
  const floated = new Subject<PartyFloated>();
  const sendFliks = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: PartyService, useValue: { floated, reactionsEnabled: () => over.partyReactions ?? true, chatEnabled: () => over.chat ?? true } },
      { provide: ReactionsService, useValue: { enabled: signal(over.reactions ?? true), animationPath: (e: string) => (e === '🔥' ? '/api/emoji/1f525.webp' : null) } },
      { provide: CastService, useValue: { isConnected: () => over.connected ?? true, castStreamBaseUrl: () => 'http://nas:3000', sendFliks } },
      { provide: TranslateService, useValue: { instant: () => ': ' } },
    ],
  });
  TestBed.inject(CastPartyRelayService);
  return { floated, sendFliks };
}

const chat: PartyFloated = { kind: 'chat', message: { id: 4, userId: 2, username: 'b', text: 'hi', system: null, sentAtMs: 0 } };

describe('CastPartyRelayService', () => {
  it('sends a reaction with its asset on the cast base, null for a static emoji', () => {
    const { floated, sendFliks } = setup();
    floated.next({ kind: 'reaction', emoji: '🔥', username: 'b' });
    floated.next({ kind: 'reaction', emoji: '🦆', username: 'b' });
    expect(sendFliks).toHaveBeenNthCalledWith(1, { kind: 'party_reaction', emoji: '🔥', username: 'b', img: 'http://nas:3000/api/emoji/1f525.webp' });
    expect(sendFliks).toHaveBeenNthCalledWith(2, { kind: 'party_reaction', emoji: '🦆', username: 'b', img: null });
  });

  it('sends chat with the translated separator', () => {
    const { floated, sendFliks } = setup();
    floated.next(chat);
    expect(sendFliks).toHaveBeenCalledWith({ kind: 'party_chat', id: 4, username: 'b', text: 'hi', sep: ': ' });
  });

  it('sends nothing when not casting', () => {
    const { floated, sendFliks } = setup({ connected: false });
    floated.next(chat);
    expect(sendFliks).not.toHaveBeenCalled();
  });

  it('follows the floaters gating per kind', () => {
    const { floated, sendFliks } = setup({ reactions: false, chat: false });
    floated.next({ kind: 'reaction', emoji: '🔥', username: 'b' });
    floated.next(chat);
    expect(sendFliks).not.toHaveBeenCalled();
  });

  it('honours the party reactions switch', () => {
    const { floated, sendFliks } = setup({ partyReactions: false });
    floated.next({ kind: 'reaction', emoji: '🔥', username: 'b' });
    expect(sendFliks).not.toHaveBeenCalled();
  });
});
