import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NavigationHistoryService } from './navigation-history.service';

@Component({ template: '' })
class Blank {}

describe('NavigationHistoryService', () => {
  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([{ path: '**', component: Blank }])],
    });
  });
  afterEach(() => sessionStorage.clear());

  /** A fresh service on a fresh router, as after a reload. */
  const reload = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([{ path: '**', component: Blank }])],
    });
    return { nav: TestBed.inject(NavigationHistoryService), router: TestBed.inject(Router) };
  };

  it('keeps the origin of a player reloaded in the same tab', async () => {
    const nav = TestBed.inject(NavigationHistoryService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/parties/1');
    await router.navigateByUrl('/watch/9');
    expect(nav.originUrl).toBe('/parties/1');

    const after = reload();
    await after.router.navigateByUrl('/watch/9');
    expect(after.nav.originUrl).toBe('/parties/1');
  });

  it('drops the stored origin when the load lands on another page', async () => {
    sessionStorage.setItem('fliks.navOrigin', '/parties/1');
    const { nav, router } = reload();
    await router.navigateByUrl('/home');
    expect(nav.originUrl).toBeNull();
    await router.navigateByUrl('/watch/9');
    expect(nav.originUrl).toBe('/home');
  });
});
