import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { KeyboardOverlayService } from '../../../core/services/keyboard-overlay.service';
import { PartyService } from '../../../core/services/party/party.service';
import { VoiceService } from '../../../core/services/party/voice.service';
import { PartySync } from '../../../core/services/party/party-sync';
import { PartySettingsComponent } from './party-settings';

function setup(isHost: boolean, confirmed = true) {
  HTMLDialogElement.prototype.showModal ??= () => {};
  HTMLDialogElement.prototype.close ??= () => {};
  const party = { isHost: signal(isHost), party: signal({ id: 7, name: 'Soirée' }), end: vi.fn().mockResolvedValue(undefined), confirmEnd: vi.fn().mockResolvedValue(confirmed) };
  TestBed.configureTestingModule({
    providers: [
      { provide: PartyService, useValue: party },
      { provide: VoiceService, useValue: { supported: false, duck: signal(false) } },
      { provide: KeyboardOverlayService, useValue: { height: signal(0) } },
      { provide: PartySync, useValue: { resync: vi.fn() } },
      provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  const fixture = TestBed.createComponent(PartySettingsComponent);
  fixture.detectChanges();
  const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.btn-error');
  return { party, button };
}

describe('PartySettingsComponent end action', () => {
  it('is hidden from a member', () => {
    expect(setup(false).button).toBeNull();
  });

  it('asks, then ends the party for the host', async () => {
    const { party, button } = setup(true);
    button!.click();
    await vi.waitFor(() => expect(party.end).toHaveBeenCalledOnce());
    expect(party.confirmEnd).toHaveBeenCalledWith('Soirée');
  });

  it('does nothing when the host declines', async () => {
    const { party, button } = setup(true, false);
    button!.click();
    await vi.waitFor(() => expect(party.confirmEnd).toHaveBeenCalled());
    expect(party.end).not.toHaveBeenCalled();
  });
});
