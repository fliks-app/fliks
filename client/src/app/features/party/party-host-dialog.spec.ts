import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PartyApiService, type PartyDto } from '../../core/services/api/party-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { KeyboardOverlayService } from '../../core/services/keyboard-overlay.service';
import { PartyService } from '../../core/services/party/party.service';
import { NavbarService } from '../../core/services/navbar.service';
import { ToastService } from '../../core/services/toast.service';
import { PartyHostDialogComponent } from './party-host-dialog';
import { signal } from '@angular/core';

function setup(status: PartyDto['status']) {
  HTMLDialogElement.prototype.close ??= () => {};
  const api = { end: vi.fn().mockResolvedValue(undefined) };
  const confirm = { confirm: vi.fn().mockResolvedValue(true) };
  TestBed.configureTestingModule({
    providers: [
      { provide: PartyApiService, useValue: api },
      { provide: ConfirmationService, useValue: confirm },
      { provide: ToastService, useValue: { info: vi.fn() } },
      { provide: Router, useValue: { navigateByUrl: vi.fn() } },
      { provide: PartyService, useValue: {} },
      { provide: NavbarService, useValue: {} },
      { provide: KeyboardOverlayService, useValue: { height: signal(0) } },
      provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  const fixture = TestBed.createComponent(PartyHostDialogComponent);
  const view = { id: 7, name: 'p', status, host: { userId: 1, username: 'a' }, guests: [], inviteToken: null, scheduledAt: null } as unknown as PartyDto;
  fixture.componentRef.setInput('view', view);
  fixture.componentRef.setInput('joined', false);
  fixture.componentRef.setInput('link', '');
  fixture.detectChanges();
  const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.btn-error');
  return { api, confirm, button };
}

describe('PartyHostDialogComponent end action', () => {
  it('offers to end a live party and confirms before calling the API', async () => {
    const { api, confirm, button } = setup('live');
    expect(button!.textContent).toContain('party.end');
    button!.click();
    await vi.waitFor(() => expect(api.end).toHaveBeenCalledWith(7));
    expect(confirm.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'party.end_title' }));
  });

  it('keeps cancel for a scheduled party', () => {
    expect(setup('scheduled').button!.textContent).toContain('party.cancel');
  });
});
