import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PersonsComponent } from './persons';
import { personListItemFixture } from '../../core/services/api/books.fixtures';

describe('PersonsComponent book mode', () => {
  it('lists the authors with their work count and keeps the role in the links', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'persons', component: PersonsComponent }]),
        provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      ],
    });
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/persons?role=author');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PersonsComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === '/api/persons' && r.params.get('role') === 'author').flush([personListItemFixture]);
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    const a: HTMLAnchorElement = fixture.nativeElement.querySelector('a[id^="person-"]');
    expect(a.getAttribute('href')).toBe('/persons/1?role=author');
    expect(fixture.componentInstance.workCounts.get(1)).toBe(2);
  });
});
