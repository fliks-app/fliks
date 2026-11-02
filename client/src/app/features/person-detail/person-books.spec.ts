import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PersonBooksComponent } from './person-books';
import { bookSearchResultFixture, personWorksFixture } from '../../core/services/api/books.fixtures';

describe('PersonBooksComponent', () => {
  it('lists owned works and only the provider credits not in a library', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PersonBooksComponent);
    fixture.componentRef.setInput('personId', 1);
    fixture.componentRef.setInput('role', 'author');
    fixture.detectChanges();
    http.expectOne((r) => r.url === '/api/persons/1/works' && r.params.get('role') === 'author').flush(personWorksFixture);
    http.expectOne('/api/persons/1/provider-credits').flush([
      bookSearchResultFixture,
      { ...bookSearchResultFixture, externalId: 'OL2W', mediaId: 7 },
    ]);
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('app-media-card').length).toBe(3);
    expect(fixture.componentInstance.missing().map((c) => c.externalId)).toEqual(['OL1W']);
    http.verify();
  });
});
