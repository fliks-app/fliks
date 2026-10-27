import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { PartyHostSwitchesComponent, switchesPatch } from './party-host-switches';

describe('PartyHostSwitchesComponent', () => {
  it('emits the public switch', () => {
    TestBed.configureTestingModule({
      providers: [provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } })],
    });
    const fixture = TestBed.createComponent(PartyHostSwitchesComponent);
    fixture.componentRef.setInput('value', { policy: 'everyone', reactionsEnabled: true, chatEnabled: true, linkSharing: true, public: false });
    const emitted: unknown[] = [];
    fixture.componentInstance.changed.subscribe((p: unknown) => emitted.push(p));
    fixture.detectChanges();
    const boxes = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect(boxes.length).toBe(5);
    boxes[4].click();
    expect(emitted).toEqual([{ public: true }]);
  });
});

describe('switchesPatch', () => {
  it('keeps only the switches that changed', () => {
    const from = { policy: 'everyone', reactionsEnabled: true, chatEnabled: true, linkSharing: true, public: false } as const;
    expect(switchesPatch(from, { ...from })).toEqual({});
    expect(switchesPatch(from, { ...from, chatEnabled: false, public: true })).toEqual({ chatEnabled: false, public: true });
  });
});
