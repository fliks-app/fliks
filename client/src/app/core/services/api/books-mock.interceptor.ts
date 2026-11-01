import { isDevMode } from '@angular/core';
import { HttpResponse, type HttpInterceptorFn } from '@angular/common/http';
import { of } from 'rxjs';
import {
  bookChaptersFixture, bookDetailFixture, bookPreviewFixture, bookSearchResultFixture,
  bookSourcesFixture, collectionDetailFixture, collectionSummaryFixture, personListItemFixture,
  personWorksFixture,
} from './books.fixtures';

function enabled(): boolean {
  try {
    return isDevMode() && localStorage.getItem('fliks.booksMock') === '1';
  } catch {
    return false;
  }
}

const ROUTES: [string, RegExp, unknown][] = [
  ['GET', /\/api\/media\/\d+\/editions\/\d+\/chapters$/, bookChaptersFixture],
  ['GET', /\/api\/media\/\d+\/sources$/, bookSourcesFixture],
  ['PUT', /\/api\/media\/\d+\/sources$/, bookSourcesFixture],
  ['DELETE', /\/api\/media\/\d+\/sources$/, bookSourcesFixture],
  ['GET', /\/api\/collections$/, [collectionSummaryFixture]],
  ['GET', /\/api\/collections\/\d+$/, collectionDetailFixture],
  ['GET', /\/api\/persons$/, [personListItemFixture]],
  ['GET', /\/api\/persons\/\d+\/works$/, personWorksFixture],
  ['GET', /\/api\/persons\/\d+\/provider-credits$/, [bookSearchResultFixture]],
  ['GET', /\/api\/metadata\/search\/book$/, [bookSearchResultFixture]],
  ['GET', /\/api\/metadata\/[a-z]+\/book\/[^/]+$/, bookPreviewFixture],
];

/** Dev only, behind `localStorage['fliks.booksMock'] = '1'`: answers the book routes from the fixtures. */
export const booksMockInterceptor: HttpInterceptorFn = (req, next) => {
  if (!enabled()) return next(req);
  const path = req.url.split('?')[0];
  const hit = ROUTES.find(([m, re]) => m === req.method && re.test(path));
  if (hit) return of(new HttpResponse({ status: 200, body: hit[2] }));
  if (req.method === 'GET' && /\/api\/media\/\d+$/.test(path)) {
    return of(new HttpResponse({ status: 200, body: { id: 1, type: 'book', title: 'Book One', book: bookDetailFixture } }));
  }
  return next(req);
};
