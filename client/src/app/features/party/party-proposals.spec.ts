import { Component, provideZonelessChangeDetection, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyApiService, type PartyItem, type PartyProposal } from '../../core/services/api/party-api.service';
import { AuthService } from '../../core/services/auth.service';
import { MediaPickerComponent } from '../../shared/components/media-picker/media-picker';
import { PartyProposalsComponent, sortProposals, topProposal } from './party-proposals';

@Component({ selector: 'app-media-picker', template: '' })
class StubPicker {
  readonly taken = input<unknown>();
  show = vi.fn();
}

const item = (title: string) => ({ mediaId: 1, episodeId: null, mediaFileId: null, title, hidden: title === '', posterUrl: null }) as PartyItem;
const prop = (id: number, voterIds: number[], proposedBy = 2, title = `T${id}`, downvoterIds: number[] = []): PartyProposal => ({ id, item: item(title), proposedBy, upvoterIds: voterIds, downvoterIds });

describe('sortProposals', () => {
  it('puts the most voted first, then the oldest', () => {
    const sorted = sortProposals([prop(3, [1]), prop(1, [1]), prop(2, [1, 2]), prop(4, [])]);
    expect(sorted.map((p) => p.id)).toEqual([2, 1, 3, 4]);
  });

  it('has no top proposal on a tie for first', () => {
    expect(topProposal([prop(1, [1]), prop(2, [2])])).toBeNull();
    expect(topProposal([prop(1, [1]), prop(2, [2], 2, 'b', [3])])?.id).toBe(1);
    expect(topProposal([])).toBeNull();
  });

  it('keeps the shown order on a tie', () => {
    const shown = [prop(2, [1]), prop(1, [1, 2])];
    expect(sortProposals([prop(1, [1]), prop(2, [1])], shown).map((p) => p.id)).toEqual([2, 1]);
  });

  it('ranks by votes for, then fewest against', () => {
    const sorted = sortProposals([prop(1, [1, 2], 2, 'a', [3, 4, 5]), prop(2, []), prop(3, [1], 2, 'c', []), prop(4, [1], 2, 'd', [2])]);
    expect(sorted.map((p) => p.id)).toEqual([1, 3, 4, 2]);
  });
});

describe('PartyProposalsComponent', () => {
  const api = { proposeMany: vi.fn(), unpropose: vi.fn(), vote: vi.fn(), choose: vi.fn() };

  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    Element.prototype.animate = vi.fn() as unknown as Element['animate'];
  });

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
  it('pops the thumb when someone else votes, not on my own vote', async () => {
    const animate = vi.fn();
    Element.prototype.animate = animate as unknown as Element['animate'];
    const f = setup({ me: 1, host: false, proposals: [prop(5, [])] });
    f.componentRef.setInput('proposals', [prop(5, [1])]);
    await f.whenStable();
    expect(animate).not.toHaveBeenCalled();
    f.componentRef.setInput('proposals', [prop(5, [1], 2, 'T5', [2])]);
    await f.whenStable();
    expect(animate).toHaveBeenCalledTimes(1);
    expect((animate.mock.contexts[0] as Element).closest('[data-value]')?.getAttribute('data-value')).toBe('-1');
    f.componentRef.setInput('proposals', [prop(5, [1])]);
    await f.whenStable();
    expect(animate).toHaveBeenCalledTimes(2);
  });

  const buttons = (f: { nativeElement: HTMLElement }, row = 0) => Array.from((f.nativeElement as HTMLElement).querySelectorAll('li')[row].querySelectorAll('button'));

  it('toggles the vote with PUT then DELETE and reflects it in aria-pressed', async () => {
    const el = setup({ me: 1, host: false, proposals: [prop(5, [1]), prop(6, [2])] });
    const [mine, other] = [buttons(el, 0)[0], buttons(el, 1)[0]];
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(other.getAttribute('aria-pressed')).toBe('false');
    mine.click();
    await vi.waitFor(() => expect(api.vote).toHaveBeenCalledTimes(1));
    other.click();
    expect(api.vote).toHaveBeenNthCalledWith(1, 9, 5, null);
    expect(api.vote).toHaveBeenNthCalledWith(2, 9, 6, 1);
  });

  it('offers delete to the author or the host only', () => {
    const rows = [prop(1, [], 1), prop(2, [], 2)];
    const guest = setup({ me: 1, host: false, proposals: rows });
    expect(buttons(guest, 0)).toHaveLength(5);
    expect(buttons(guest, 1)).toHaveLength(4);
    TestBed.resetTestingModule();
    const host = setup({ me: 3, host: true, proposals: rows });
    expect(buttons(host, 1).some((b) => b.querySelector('svg'))).toBe(true);
    expect(buttons(host, 0)).toHaveLength(6);
  });

  it('shows Choose to the host only and emits the new snapshot', async () => {
    const guest = setup({ me: 2, host: false, proposals: [prop(1, [])] });
    expect(buttons(guest)).toHaveLength(5);
    TestBed.resetTestingModule();
    const host = setup({ me: 1, host: true, proposals: [prop(1, [])] });
    api.choose.mockResolvedValue({ id: 9 });
    const chosen = vi.fn();
    host.componentInstance.chosen.subscribe(chosen);
    expect(buttons(host)).toHaveLength(6);
    buttons(host).find((b) => b.textContent?.includes('party.choose'))!.click();
    await vi.waitFor(() => expect(chosen).toHaveBeenCalledWith({ id: 9 }));
    expect(api.choose).toHaveBeenCalledWith(9, 1);
  });

  it('keeps the vote button enabled and focused while the request runs', async () => {
    const el = setup({ me: 1, host: false, proposals: [prop(5, [1])] });
    document.body.append(el.nativeElement);
    api.vote.mockReturnValue(new Promise(() => {}));
    const vote = buttons(el)[0];
    vote.focus();
    vote.click();
    el.detectChanges();
    expect(vote.disabled).toBe(false);
    expect(document.activeElement).toBe(vote);
    vote.click();
    expect(api.vote).toHaveBeenCalledTimes(1);
    el.nativeElement.remove();
  });

  it('puts the focus back on the vote button when the re-sort moves its row', async () => {
    const el = setup({ me: 1, host: false, proposals: [prop(5, [], 2), prop(6, [], 2)] });
    document.body.append(el.nativeElement);
    const vote = () => (el.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-vote="6"]')!;
    vote().focus();
    vote().click();
    await vi.waitFor(() => expect(api.vote).toHaveBeenCalled());
    el.componentRef.setInput('proposals', [prop(5, [], 2), prop(6, [1], 2)]);
    el.detectChanges();
    await el.whenStable();
    expect((el.nativeElement as HTMLElement).querySelector('li [data-vote]')!.getAttribute('data-vote')).toBe('6');
    expect(document.activeElement).toBe(vote());
    el.nativeElement.remove();
  });

  it('offers no Choose on a masked proposal', () => {
    const el = setup({ me: 1, host: true, proposals: [prop(1, [], 2, '')] });
    expect(buttons(el)).toHaveLength(5);
  });

  it('shows a neutral text for a masked title', () => {
    const el = setup({ me: 1, host: false, proposals: [prop(1, [], 2, '')] });
    expect(el.nativeElement.querySelector('li')!.textContent).toContain('party.proposal_hidden');
  });
});
