import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { MultiSelectComponent, MultiSelectOption } from './multi-select';
import { DeviceService } from '../../../../core/services/device.service';
import { TvService } from '../../../../core/services/tv.service';
import { DismissableStackService } from '../../../../core/services/dismissable-stack.service';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

async function settle(fixture: ComponentFixture<unknown>) {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

function createFixture<T extends string | number>(options: readonly MultiSelectOption<T>[], value: T[] = []) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      // Desktop with a mouse renders the anchored dropdown, not the bottom sheet.
      { provide: DeviceService, useValue: { isTouch: () => false, isDesktop: () => true } },
      { provide: TvService, useValue: { isTv: () => false } },
      { provide: DismissableStackService, useValue: { push: () => {}, remove: () => {} } },
    ],
  });
  const fixture = TestBed.createComponent<MultiSelectComponent<T>>(MultiSelectComponent);
  fixture.componentRef.setInput('options', options);
  fixture.componentRef.setInput('value', value);
  fixture.detectChanges();
  return fixture;
}

/** The open panel is reparented under `<html>` (see PopoverMenuComponent), so its checkboxes
 *  live outside the fixture's own DOM once open. */
function checkboxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type="checkbox"]'));
}

async function openTrigger(fixture: ComponentFixture<unknown>): Promise<void> {
  (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
  await settle(fixture);
}

describe('MultiSelectComponent: string values', () => {
  const OPTIONS: MultiSelectOption<string>[] = [
    { value: 'sub', label: 'Subtitles' },
    { value: 'meta', label: 'Metadata' },
  ];

  it('ticking an option writes a string[] value', async () => {
    const fixture = createFixture(OPTIONS);
    await openTrigger(fixture);

    const box = checkboxes()[0]!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));

    expect(fixture.componentInstance.value()).toEqual(['sub']);
  });

  it('unticking removes it from the array', async () => {
    const fixture = createFixture(OPTIONS, ['sub', 'meta']);
    await openTrigger(fixture);

    checkboxes()[0]!.dispatchEvent(new Event('change'));

    expect(fixture.componentInstance.value()).toEqual(['meta']);
  });

  it('renders a chip per picked option, labelled from `options`', () => {
    const fixture = createFixture(OPTIONS, ['meta']);
    expect(fixture.nativeElement.textContent).toContain('Metadata');
  });
});

describe('MultiSelectComponent: number values (existing behaviour)', () => {
  const OPTIONS: MultiSelectOption<number>[] = [
    { value: 1, label: 'Library A' },
    { value: 2, label: 'Library B' },
  ];

  it('ticking an option writes a number[] value', async () => {
    const fixture = createFixture(OPTIONS);
    await openTrigger(fixture);

    checkboxes()[1]!.dispatchEvent(new Event('change'));

    expect(fixture.componentInstance.value()).toEqual([2]);
  });

  it('does not open while disabled', async () => {
    const fixture = createFixture(OPTIONS);
    fixture.componentRef.setInput('disabled', true);
    await openTrigger(fixture);
    expect(checkboxes()).toHaveLength(0);
  });
});
