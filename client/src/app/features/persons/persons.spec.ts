import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PersonsComponent } from './persons';
import { personListItemFixture } from '../../testing/books.fixtures';
import type { Person } from '../../core/services/api/persons-api.service';

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
    // The virtual viewport renders its first rows on a later pass.
    await fixture.whenStable();
    fixture.detectChanges();
    const a: HTMLAnchorElement = fixture.nativeElement.querySelector('[id^="person-"] a');
    expect(a.getAttribute('href')).toBe('/persons/1?role=author');
    expect(fixture.componentInstance.workCounts.get(1)).toBe(2);
  });
});

describe('PersonsComponent cast and crew', () => {
  const person = (id: number): Person => ({
    id, tmdbId: id, name: `Person ${String(id).padStart(3, '0')}`, avatarUrl: null, biography: null, birthday: null,
    deathday: null, placeOfBirth: null, knownForDepartment: null, departments: [], metadataRefreshedAt: null,
  });
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => person(from + i));

  async function open() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'persons', component: PersonsComponent }]),
        provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      ],
    });
    await TestBed.inject(Router).navigateByUrl('/persons');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PersonsComponent);
    fixture.detectChanges();
    const search = (p: Record<string, string>) =>
      http.expectOne((r) => r.url === '/api/persons/search' && Object.entries(p).every(([k, v]) => r.params.get(k) === v));
    const settle = async () => {
      await new Promise((r) => setTimeout(r));
      fixture.detectChanges();
    };
    return { fixture, search, settle };
  }

  it('asks for the next page on show more and stops after a short page', async () => {
    const { fixture, search, settle } = await open();
    search({ page: '1', limit: '50' }).flush(page(1, 50));
    await settle();
    fixture.nativeElement.querySelector('[data-testid="persons-more"]').click();
    search({ page: '2', limit: '50' }).flush(page(51, 3));
    await settle();
    expect(fixture.componentInstance.list.total()).toBe(53);
    expect(fixture.nativeElement.querySelector('[data-testid="persons-more"]')).toBeNull();
  });

  it('sends the letter and the role to the server and restarts at the first page', async () => {
    const { fixture, search, settle } = await open();
    search({ page: '1' }).flush(page(1, 50));
    await settle();
    const letters: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('[data-alpha-index] button'));
    letters.find((b) => b.textContent?.trim() === 'B')!.click();
    search({ page: '1', letter: 'B' }).flush([]);
    await settle();
    fixture.componentInstance.onFilterRole('Acting');
    search({ page: '1', letter: 'B', department: 'Acting' }).flush([person(1)]);
    await settle();
    expect(fixture.componentInstance.list.total()).toBe(1);
  });
});
