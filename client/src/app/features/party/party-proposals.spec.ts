import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyApiService, type PartyItem, type PartyProposal } from '../../core/services/api/party-api.service';
import { AuthService } from '../../core/services/auth.service';
import { MediaPickerComponent } from '../../shared/components/media-picker/media-picker';
import { PartyProposalsComponent, sortProposals } from './party-proposals';

@Component({ selector: 'app-media-picker', template: '' })
class StubPicker {
  show = vi.fn();
}

const item = (title: string) => ({ mediaId: 1, episodeId: null, mediaFileId: null, title, posterUrl: null }) as PartyItem;
const prop = (id: number, voterIds: number[], proposedBy = 2, title = `T${id}`): PartyProposal => ({ id, item: item(title), proposedBy, voterIds });

describe('sortProposals', () => {
  it('puts the most voted first, then the oldest', () => {
    const sorted = sortProposals([prop(3, [1]), prop(1, [1]), prop(2, [1, 2]), prop(4, [])]);
    expect(sorted.map((p) => p.id)).toEqual([2, 1, 3, 4]);
  });
});

describe('PartyProposalsComponent', () => {
  const api = { propose: vi.fn(), unpropose: vi.fn(), vote: vi.fn(), choose: vi.fn() };

  function setup(opts: { me: number; host: boolean; proposals: PartyProposal[] }) {
    Object.values(api).forEach((f) => f.mockReset().mockResolvedValue(undefined));
    TestBed.overrideComponent(PartyProposalsComponent, { remove: { imports: [MediaPickerComponent] }, add: { imports: [StubPicker] } });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: PartyApiService, useValue: api },
        { provide: AuthService, useValue: { user: () => ({ id: opts.me }) } },
      ],
    });
    const fixture = TestBed.createComponent(PartyProposalsComponent);
    fixture.componentRef.setInput('partyId', 9);
    fixture.componentRef.setInput('proposals', opts.proposals);
    fixture.componentRef.setInput('people', [{ userId: 1, username: 'a' }, { userId: 2, username: 'b' }]);
    fixture.componentRef.setInput('isHost', opts.host);
    fixture.detectChanges();
    return fixture;
  }
  const buttons = (f: { nativeElement: HTMLElement }, row = 0) => Array.from((f.nativeElement as HTMLElement).querySelectorAll('li')[row].querySelectorAll('button'));

  it('toggles the vote with PUT then DELETE and reflects it in aria-pressed', () => {
    const el = setup({ me: 1, host: false, proposals: [prop(5, [1]), prop(6, [2])] });
    const [mine, other] = [buttons(el, 0)[0], buttons(el, 1)[0]];
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(other.getAttribute('aria-pressed')).toBe('false');
    mine.click();
    other.click();
    expect(api.vote).toHaveBeenNthCalledWith(1, 9, 5, false);
    expect(api.vote).toHaveBeenNthCalledWith(2, 9, 6, true);
  });

  it('offers delete to the author or the host only', () => {
    const rows = [prop(1, [], 1), prop(2, [], 2)];
    const guest = setup({ me: 1, host: false, proposals: rows });
    expect(buttons(guest, 0)).toHaveLength(2);
    expect(buttons(guest, 1)).toHaveLength(1);
    TestBed.resetTestingModule();
    const host = setup({ me: 3, host: true, proposals: rows });
    expect(buttons(host, 1).some((b) => b.querySelector('svg'))).toBe(true);
    expect(buttons(host, 0)).toHaveLength(3);
  });

  it('shows Choose to the host only and emits the new snapshot', async () => {
    const guest = setup({ me: 2, host: false, proposals: [prop(1, [])] });
    expect(buttons(guest)).toHaveLength(2);
    TestBed.resetTestingModule();
    const host = setup({ me: 1, host: true, proposals: [prop(1, [])] });
    api.choose.mockResolvedValue({ id: 9 });
    const chosen = vi.fn();
    host.componentInstance.chosen.subscribe(chosen);
    expect(buttons(host)).toHaveLength(3);
    buttons(host)[1].click();
    await vi.waitFor(() => expect(chosen).toHaveBeenCalledWith({ id: 9 }));
    expect(api.choose).toHaveBeenCalledWith(9, 1);
  });

  it('shows a neutral text for a masked title', () => {
    const el = setup({ me: 1, host: false, proposals: [prop(1, [], 2, '')] });
    expect(el.nativeElement.querySelector('li')!.textContent).toContain('party.proposal_hidden');
  });
});
