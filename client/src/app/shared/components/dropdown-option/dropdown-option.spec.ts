import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DropdownOptionComponent } from './dropdown-option';

/**
 * `aria-current` is not decoration here: it is the marker
 * `initialOverlayFocus` looks for, so it decides whether a menu opens on the
 * current choice or at the top of the list.
 */
describe('DropdownOptionComponent', () => {
  const render = (selected: boolean) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(DropdownOptionComponent);
    fixture.componentRef.setInput('head', 'French');
    fixture.componentRef.setInput('selected', selected);
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  };

  it('marks the selected option as current so a menu opens on it', () => {
    expect(render(true).getAttribute('aria-current')).toBe('true');
  });

  it('leaves an unselected option unmarked, so exactly one is the target', () => {
    expect(render(false).getAttribute('aria-current')).toBeNull();
  });
});
