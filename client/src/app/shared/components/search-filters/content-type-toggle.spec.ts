import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateLoader } from '@ngx-translate/core';
import { of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentTypeToggleComponent } from './content-type-toggle';

function render(withBooks?: boolean) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
    ],
  });
  const fixture = TestBed.createComponent(ContentTypeToggleComponent);
  if (withBooks !== undefined) fixture.componentRef.setInput('withBooks', withBooks);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ContentTypeToggleComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('offers all, movies and series by default', () => {
    expect(render().querySelectorAll('button').length).toBe(3);
  });

  it('adds Books on demand', () => {
    expect(render(true).querySelectorAll('button').length).toBe(4);
  });
});
