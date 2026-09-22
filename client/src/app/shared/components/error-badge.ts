import { Component, computed, inject, input } from '@angular/core';
import { NgClass } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { translatedServerMessage } from '../../core/utils/server-message';

/**
 * Status badge that opens the app's shared alert modal with the full error text when one
 * exists, and renders as a plain (non-clickable) badge otherwise. Same `badge-sm` size
 * everywhere so callers don't each pick their own.
 */
@Component({
  selector: 'app-error-badge',
  imports: [NgClass, TranslatePipe],
  templateUrl: './error-badge.html',
})
export class ErrorBadgeComponent {
  private readonly translate = inject(TranslateService);
  private readonly confirm = inject(ConfirmationService);

  readonly error = input<string | null>(null);
  readonly label = input.required<string>();
  /** `null` renders the label as plain text instead of a badge pill. */
  readonly badgeClass = input<string | null>('badge-error');
  readonly titleKey = input('activity.error_detail_title');

  /** A translation key resolves; a raw engine/provider error passes through as-is. */
  readonly errorText = computed(() => {
    const raw = (this.error() ?? '').trim();
    return raw ? (translatedServerMessage(raw, this.translate) ?? raw) : '';
  });

  open(): void {
    const message = this.errorText();
    if (!message) return;
    void this.confirm.alert({
      title: this.translate.instant(this.titleKey()),
      message,
      monospace: true,
    });
  }
}
