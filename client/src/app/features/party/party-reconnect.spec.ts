import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { PartyService } from '../../core/services/party/party.service';
import { PartyReconnectComponent } from './party-reconnect';

describe('PartyReconnectComponent', () => {
  it('opens while reconnecting, and its action leaves the party and goes home', async () => {
    const reconnecting = signal<'server' | 'room' | null>(null);
    const leaveOrEnd = vi.fn().mockResolvedValue(true);
    const navigateByUrl = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: PartyService, useValue: { reconnecting, leaveOrEnd } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    });
    const fixture = TestBed.createComponent(PartyReconnectComponent);
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    dialog.close = vi.fn(() => dialog.removeAttribute('open'));
    fixture.detectChanges();
    expect(dialog.open).toBe(false);
    reconnecting.set('server');
    fixture.detectChanges();
    expect(dialog.open).toBe(true);
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r));
    expect(leaveOrEnd).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/');
    reconnecting.set(null);
    fixture.detectChanges();
    expect(dialog.open).toBe(false);
  });
});
