import { TestBed } from '@angular/core/testing';
import { PageScrollModeService } from './page-scroll-mode.service';
import { DeviceService, FormFactor } from './device.service';

const OVERRIDE_KEY = 'fliks.scrollModeOverride';

function setUp(formFactor: FormFactor): PageScrollModeService {
  TestBed.configureTestingModule({
    providers: [{ provide: DeviceService, useValue: { formFactor: () => formFactor } }],
  });
  return TestBed.inject(PageScrollModeService);
}

function setSearch(search: string): void {
  // A relative empty string resolves against the current URL and changes
  // nothing, so the path is always spelled out to actually clear a query.
  history.pushState(null, '', window.location.pathname + search);
}

describe('PageScrollModeService', () => {
  const originalSearch = window.location.search;

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem(OVERRIDE_KEY);
    setSearch(originalSearch);
    document.documentElement.classList.remove('scroll-mode-window', 'scroll-mode-container');
  });

  it('maps phone and tablet to container', () => {
    setSearch('');
    expect(setUp('phone').mode()).toBe('container');
    TestBed.resetTestingModule();
    expect(setUp('tablet').mode()).toBe('container');
  });

  it('maps tv and desktop to window', () => {
    setSearch('');
    expect(setUp('tv').mode()).toBe('window');
    TestBed.resetTestingModule();
    expect(setUp('desktop').mode()).toBe('window');
  });

  it('a ?scroll= query param overrides the map and persists it', () => {
    setSearch('?scroll=window');
    const svc = setUp('phone');
    expect(svc.mode()).toBe('window');
    expect(localStorage.getItem(OVERRIDE_KEY)).toBe('window');
  });

  it('the persisted override survives a later navigation with no query param', () => {
    localStorage.setItem(OVERRIDE_KEY, 'container');
    setSearch('');
    expect(setUp('tv').mode()).toBe('container');
  });

  it('?reset-scroll clears a persisted override', () => {
    localStorage.setItem(OVERRIDE_KEY, 'window');
    setSearch('?reset-scroll');
    const svc = setUp('phone');
    expect(svc.mode()).toBe('container');
    expect(localStorage.getItem(OVERRIDE_KEY)).toBeNull();
  });

  it('syncs the resolved mode onto <html> as a class, observable outside Angular', () => {
    setSearch('');
    setUp('tv');
    TestBed.tick();
    expect(document.documentElement.classList.contains('scroll-mode-window')).toBe(true);
    expect(document.documentElement.classList.contains('scroll-mode-container')).toBe(false);
  });
});
