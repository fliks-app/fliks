import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { bookSpecProviders } from '../../../features/media-detail/book/book-test-setup';
import type { WantSpec } from '../../../core/services/api/wants-api.service';
import { WantsEditorComponent } from './wants-editor';

function setup(wants: WantSpec[]) {
  TestBed.configureTestingModule({ providers: bookSpecProviders() });
  const fixture = TestBed.createComponent(WantsEditorComponent);
  fixture.componentRef.setInput('wants', wants);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rows = () => Array.from(el.querySelectorAll('[data-testid="want-row"]'));
  return { fixture, el, rows };
}

describe('WantsEditorComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('adds the first pair not wished yet and removes a row', () => {
    const { fixture, el, rows } = setup([{ family: 'text', language: null }]);
    const add = Array.from(el.querySelectorAll('button')).at(-1) as HTMLButtonElement;
    add.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.wants()).toEqual([
      { family: 'text', language: null },
      { family: 'audio', language: null },
    ]);
    expect(rows()).toHaveLength(2);
    (rows()[0].querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.wants()).toEqual([{ family: 'audio', language: null }]);
  });

  it('keeps the last row', () => {
    const { rows } = setup([{ family: 'text', language: 'fr' }]);
    expect((rows()[0].querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets the profile when the family changes', () => {
    const { fixture } = setup([{ family: 'text', language: null, qualityProfileId: 3 }]);
    fixture.componentInstance['setFamily'](0, 'audio');
    expect(fixture.componentInstance.wants()).toEqual([{ family: 'audio', language: null, qualityProfileId: null }]);
  });

  it('starts every row on its family first profile when a profile is required', () => {
    const { fixture } = setup([{ family: 'text', language: null }, { family: 'audio', language: 'en', qualityProfileId: 9 }]);
    fixture.componentRef.setInput('profileRequired', true);
    fixture.componentInstance['profiles'].set({ text: [{ id: 4 }, { id: 5 }] as never, audio: [] });
    fixture.detectChanges();
    expect(fixture.componentInstance.wants().map((w) => w.qualityProfileId)).toEqual([4, 9]);
    expect(fixture.nativeElement.textContent).not.toContain('wants.no_profile');
  });
});
