import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { NgClass } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ModalHeaderComponent } from './modal-header';
import { ModalFooterComponent } from './modal-footer';

/**
 * Status badge that opens a modal with the full error text when one exists,
 * and renders as a plain (non-clickable) badge otherwise. Same `badge-sm`
 * size everywhere so callers don't each pick their own.
 */
@Component({
  selector: 'app-error-badge',
  imports: [NgClass, TranslatePipe, ModalHeaderComponent, ModalFooterComponent],
  templateUrl: './error-badge.html',
})
export class ErrorBadgeComponent {
  private readonly translate = inject(TranslateService);

  readonly error = input<string | null>(null);
  readonly label = input.required<string>();
  readonly badgeClass = input('badge-error');

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** A translation key resolves; a raw engine/provider error passes through as-is. */
  readonly errorText = computed(() => {
    const raw = (this.error() ?? '').trim();
    if (!raw) return '';
    const translated = this.translate.instant(raw);
    return translated === raw ? raw : translated;
  });

  readonly errorDetail = signal('');

  open(): void {
    const text = this.errorText();
    if (!text) return;
    this.errorDetail.set(text);
    this.dialog()?.nativeElement.showModal();
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }
}
