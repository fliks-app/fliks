import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { CollectionDetailComponent } from './collection-detail';
import { collectionDetailFixture } from '../../core/services/api/books.fixtures';

describe('CollectionDetailComponent', () => {
  async function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: new Map([['id', '10']]) } } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CollectionDetailComponent);
    http.expectOne('/api/collections/10').flush(collectionDetailFixture);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, http };
  }

  it('interleaves entries and missing positions in order, with the next-up link', async () => {
    const { fixture, http } = await setup();
    const tiles = fixture.componentInstance.tiles();
    expect(tiles.map((t) => t.position)).toEqual([1, 2, 3]);
    expect(tiles[1].kind).toBe('missing');
    expect(fixture.nativeElement.querySelectorAll('[data-missing]').length).toBe(1);
    expect(fixture.componentInstance.nextUp()).toEqual(['/books', '3']);
    http.verify();
  });
});
