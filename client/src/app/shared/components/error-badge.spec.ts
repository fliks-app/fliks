import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { ErrorBadgeComponent } from './error-badge';

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
});

function createFixture() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: {
          provide: TranslateLoader,
          useValue: {
            getTranslation: () => of({ activity: { some_error_key: 'Translated failure' } }),
          },
        },
      }),
    ],
  });
  const fixture = TestBed.createComponent(ErrorBadgeComponent);
  fixture.componentRef.setInput('label', 'Error');
  return fixture;
}

/** The trigger button, as opposed to the ones inside the (always-rendered) dialog markup. */
function triggerButton(root: HTMLElement): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll('button')).find((b) => !b.closest('dialog')) ?? null;
}

describe('ErrorBadgeComponent', () => {
  it('renders a bare, non-clickable badge when there is no error', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('error', null);
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    expect(triggerButton(root)).toBeNull();
    expect(root.querySelector('.badge')?.textContent?.trim()).toBe('Error');
  });

  it('renders a button that opens the detail modal when an error is set', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('error', 'engine exploded');
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    const button = triggerButton(root);
    expect(button).not.toBeNull();

    const dialog = root.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(false);

    button!.click();
    fixture.detectChanges();

    expect(dialog.hasAttribute('open')).toBe(true);
    expect(root.querySelector('pre')?.textContent?.trim()).toBe('engine exploded');
  });

  it('translates the error when it is a known i18n key', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('error', 'activity.some_error_key');
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    triggerButton(root)!.click();
    fixture.detectChanges();

    expect(root.querySelector('pre')?.textContent?.trim()).toBe('Translated failure');
  });
});
