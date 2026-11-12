import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SelectPickerComponent } from './select-picker';
import { SelectPickerService } from '../../core/services/select-picker.service';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

async function settle(fixture: ComponentFixture<unknown>) {
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

function makeSelect(count: number): HTMLSelectElement {
  const select = document.createElement('select');
  for (let i = 0; i < count; i++) select.add(new Option(i === 0 ? 'Alpha' : `Item ${i}`, `v${i}`));
  document.body.appendChild(select);
  return select;
}

// The open panel is reparented under <html>, so query the document.
const filter = () => document.querySelector<HTMLInputElement>('app-popover-menu input[type="text"]');
const items = () => Array.from(document.querySelectorAll('app-popover-menu .dropdown-item'));

describe('SelectPickerComponent filter', () => {
  let fixture: ComponentFixture<SelectPickerComponent>;
  let picker: SelectPickerService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
        { provide: DeviceService, useValue: { isTouch: () => false, isDesktop: () => true } },
        { provide: TvService, useValue: { isTv: () => false } },
        { provide: DismissableStackService, useValue: { push: () => {}, remove: () => {} } },
      ],
    });
    fixture = TestBed.createComponent(SelectPickerComponent);
    picker = TestBed.inject(SelectPickerService);
  });

  afterEach(() => {
    document.querySelectorAll('select').forEach((s) => s.remove());
  });

  async function open(count: number) {
    picker.show(makeSelect(count));
    await settle(fixture);
  }

  async function type(text: string) {
    const input = filter()!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
  }

  it('hides the filter below 8 options', async () => {
    await open(7);
    expect(filter()).toBeNull();
  });

  it('shows the filter from 8 options and focuses it', async () => {
    await open(8);
    expect(filter()).not.toBeNull();
    expect(document.activeElement).toBe(filter());
  });

  it('filters case-insensitively and shows an empty state', async () => {
    await open(10);
    await type('ITEM 3');
    expect(items().map((e) => e.textContent?.trim())).toEqual(['Item 3']);
    await type('zzz');
    expect(items()).toHaveLength(0);
    expect(document.querySelector('app-popover-menu')!.textContent).toContain('common.no_results');
  });

  it('resets the filter when reopened', async () => {
    await open(10);
    await type('Item 3');
    picker.close();
    await settle(fixture);
    await open(10);
    expect(filter()!.value).toBe('');
    expect(items()).toHaveLength(10);
  });
});
