import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { PartyItem } from '../../../core/services/api/party-api.service';
import { DeviceService } from '../../../core/services/device.service';
import { PartyService } from '../../../core/services/party/party.service';
import { KaraokeQueueComponent } from './karaoke-queue';

const row = (n: number, addedBy: number | null) => ({ title: `Song ${n}`, mediaId: 9, itemId: 5000 + n, addedBy }) as PartyItem;

function setup(rows: PartyItem[]) {
  const upNext = signal(rows);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: PartyService, useValue: { upNext, userName: (id: number | null) => ({ 2: 'cara', 3: 'bob' })[id as number] ?? '' } },
      { provide: DeviceService, useValue: { isTv: () => false } },
    ],
  });
  const fixture = TestBed.createComponent(KaraokeQueueComponent);
  fixture.detectChanges();
  return { upNext, fixture, el: fixture.nativeElement as HTMLElement };
}

describe('KaraokeQueueComponent', () => {
  it('lists the next rows with their singers', () => {
    const { el } = setup([row(1, 2), row(2, 3)]);
    const items = [...el.querySelectorAll('[data-testid="karaoke-queue-item"]')];
    expect(items.map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Song 1 cara', 'Song 2 bob']);
  });

  it('is absent while nothing is waiting, and has no search', async () => {
    const { upNext, fixture, el } = setup([]);
    expect(el.querySelector('[data-testid="karaoke-queue"]')).toBeNull();
    upNext.set([row(1, 2)]);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="karaoke-queue"]')).not.toBeNull();
    expect(el.querySelector('input')).toBeNull();
  });
});
