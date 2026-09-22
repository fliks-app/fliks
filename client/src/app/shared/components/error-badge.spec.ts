import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ErrorBadgeComponent } from './error-badge';
import { ConfirmationService } from '../../core/services/confirmation.service';

function createFixture() {
  const confirm = { alert: vi.fn().mockResolvedValue(undefined) };
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
      { provide: ConfirmationService, useValue: confirm },
    ],
  });
  const fixture = TestBed.createComponent(ErrorBadgeComponent);
  fixture.componentRef.setInput('label', 'Error');
  return { fixture, confirm };
}

describe('ErrorBadgeComponent', () => {
  it('renders a bare, non-clickable badge when there is no error', () => {
    const { fixture } = createFixture();
    fixture.componentRef.setInput('error', null);
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('button')).toBeNull();
    expect(root.querySelector('.badge')?.textContent?.trim()).toBe('Error');
  });

  it('renders no button for an error that is only whitespace', () => {
    const { fixture } = createFixture();
    fixture.componentRef.setInput('error', '   ');
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).querySelector('button')).toBeNull();
  });

  it('opens the shared alert modal with the resolved text when clicked', () => {
    const { fixture, confirm } = createFixture();
    fixture.componentRef.setInput('error', 'engine exploded');
    fixture.detectChanges();

    const button: HTMLButtonElement | null = fixture.nativeElement.querySelector('button');
    expect(button).not.toBeNull();

    button!.click();

    expect(confirm.alert).toHaveBeenCalledWith({
      title: 'activity.error_detail_title',
      message: 'engine exploded',
      monospace: true,
    });
  });

  it('translates the error when it is a known i18n key', () => {
    const { fixture, confirm } = createFixture();
    fixture.componentRef.setInput('error', 'activity.some_error_key');
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button')!.click();

    expect(confirm.alert).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Translated failure' }),
    );
  });

  it('renders the label as plain text, no badge pill, when badgeClass is null', () => {
    const { fixture } = createFixture();
    fixture.componentRef.setInput('badgeClass', null);
    fixture.detectChanges();

    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('.badge')).toBeNull();
    expect(root.textContent?.trim()).toBe('Error');
  });

  it('applies the given badgeClass to the badge pill', () => {
    const { fixture } = createFixture();
    fixture.componentRef.setInput('badgeClass', 'badge-warning');
    fixture.detectChanges();

    const badge = (fixture.nativeElement as HTMLElement).querySelector('.badge');
    expect(badge?.className).toContain('badge-warning');
    expect(badge?.className).not.toContain('badge-error');
  });
});
