import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SettingsIconComponent } from './settings-icon';

/** The rendered SVG children, not the attribute: an unimported directive still leaves its
 *  attribute in the template's markup, so only the drawn paths prove the icon resolved. */
function renderIcon(name: string): string {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(SettingsIconComponent);
  fixture.componentRef.setInput('name', name);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector('svg')!.innerHTML;
}

describe('SettingsIconComponent', () => {
  const declaredByRealPlugins = ['webhook', 'download', 'search', 'server', 'history', 'settings'];

  for (const name of declaredByRealPlugins) {
    it(`draws an icon for "${name}", a name real plugins declare`, () => {
      expect(renderIcon(name).trim().length).toBeGreaterThan(0);
    });
  }

  it('draws a different icon per name rather than one shared glyph', () => {
    const drawn = declaredByRealPlugins.map(renderIcon);
    expect(new Set(drawn).size).toBe(declaredByRealPlugins.length);
  });

  it('falls back to a drawn circle for a name it does not know', () => {
    const fallback = renderIcon('some-plugin-invented-name');
    expect(fallback.trim().length).toBeGreaterThan(0);
    expect(fallback).toBe(renderIcon('another-unknown-name'));
  });
});
