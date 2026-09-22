import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { EnabledSwitchComponent } from './enabled-switch';

function createFixture() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: {
          provide: TranslateLoader,
          useValue: {
            getTranslation: () => of({ common: { active: 'Active' }, x: { y: 'Custom' } }),
          },
        },
      }),
    ],
  });
  const fixture = TestBed.createComponent(EnabledSwitchComponent);
  fixture.componentRef.setInput('enabled', false);
  return fixture;
}

async function settle(fixture: ComponentFixture<unknown>) {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

function checkboxOf(fixture: ComponentFixture<unknown>): HTMLInputElement {
  return (fixture.nativeElement as HTMLElement).querySelector('input[type="checkbox"]')!;
}

describe('EnabledSwitchComponent', () => {
  it('resyncs the checkbox to the input value when the parent leaves enabled unchanged', async () => {
    const fixture = createFixture();
    await settle(fixture);
    const checkbox = checkboxOf(fixture);
    const emitted: void[] = [];
    fixture.componentInstance.toggle.subscribe(() => emitted.push(undefined));

    // The native click flips the DOM state before Angular ever runs, the same
    // way a real browser click does.
    checkbox.click();
    expect(checkbox.checked).toBe(true);
    expect(emitted.length).toBe(1);

    // Parent's request fails: busy clears without `enabled` ever changing.
    fixture.componentRef.setInput('busy', true);
    await settle(fixture);
    fixture.componentRef.setInput('busy', false);
    await settle(fixture);

    expect(checkbox.checked).toBe(false);
  });

  it('leaves the checkbox alone while busy stays false with no toggle', async () => {
    const fixture = createFixture();
    await settle(fixture);
    const checkbox = checkboxOf(fixture);
    expect(checkbox.checked).toBe(false);
  });

  it('disables the checkbox while busy', async () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('busy', true);
    await settle(fixture);
    expect(checkboxOf(fixture).disabled).toBe(true);
  });

  it('disables the checkbox when disabled is set, independently of busy', async () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('disabled', true);
    await settle(fixture);
    expect(checkboxOf(fixture).disabled).toBe(true);
  });

  it('translates the default aria-label', async () => {
    const fixture = createFixture();
    await settle(fixture);
    expect(checkboxOf(fixture).getAttribute('aria-label')).toBe('Active');
  });

  it('translates a caller-provided aria-label key', async () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('ariaLabelKey', 'x.y');
    await settle(fixture);
    expect(checkboxOf(fixture).getAttribute('aria-label')).toBe('Custom');
  });
});
