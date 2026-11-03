import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { RequestWantsComponent } from './request-wants';

describe('RequestWantsComponent', () => {
  it('shows one badge per wished edition', () => {
    TestBed.configureTestingModule({ imports: [RequestWantsComponent], providers: [provideTranslateService({ lang: 'en' })] });
    const f = TestBed.createComponent(RequestWantsComponent);
    f.componentRef.setInput('wants', [
      { family: 'text', language: 'fr' },
      { family: 'audio', language: null },
    ]);
    f.detectChanges();
    expect(f.nativeElement.querySelectorAll('.badge')).toHaveLength(2);
  });
});
