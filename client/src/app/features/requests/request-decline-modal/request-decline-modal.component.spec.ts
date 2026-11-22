import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RequestDeclineModalComponent } from './request-decline-modal.component';

describe('RequestDeclineModalComponent', () => {
  it('fills the reason with the picked chip and marks it', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({ requests: { decline_reason_no_space: 'Not enough space' } }) } },
        }),
      ],
    });
    const fixture = TestBed.createComponent(RequestDeclineModalComponent);
    const text = vi.fn();
    fixture.componentInstance.reasonTextChange.subscribe(text);
    fixture.detectChanges();
    const chips = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button.btn-outline')];
    expect(chips).toHaveLength(4);
    chips[3].click();
    expect(text).toHaveBeenCalledWith('Not enough space');
    fixture.componentRef.setInput('reasonText', 'Not enough space');
    fixture.detectChanges();
    expect(chips[3].getAttribute('aria-pressed')).toBe('true');
    expect(chips[0].getAttribute('aria-pressed')).toBe('false');
  });
});
