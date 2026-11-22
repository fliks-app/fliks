import { Component, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { isTypingTarget } from '../../core/utils/typing-target';
import { LucideShield } from '@lucide/angular';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { CardActionsPanelComponent } from '../../shared/components/card-actions-panel/card-actions-panel';
import { SettingsIconComponent } from './settings-icon';
import { SettingsSectionsService } from './settings-sections.service';

@Component({
  selector: 'app-admin-shell',
  imports: [
    CardActionsPanelComponent,
    RouterLink, TranslatePipe,
    SettingsDrawerComponent, SettingsIconComponent,
    LucideShield,
  ],
  templateUrl: './admin-shell.html',
})
export class AdminShellComponent {
  private readonly settings = inject(SettingsSectionsService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');
  protected readonly filter = signal('');

  /** Matches the translated label plus the optional `settings.nav_words.<id>` synonyms; sections left empty hide. */
  protected readonly sections = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const all = this.settings.sections();
    if (!q) return all;
    return all
      .map((s) => ({ ...s, items: s.items.filter((i) => this.matches(i, q)) }))
      .filter((s) => s.items.length > 0);
  });
  readonly activeItemId = this.settings.activeItemId;

  private matches(item: { id: string; labelKey: string }, q: string): boolean {
    const wordsKey = `settings.nav_words.${item.id.replace(/^core\./, '')}`;
    const words = this.translate.instant(wordsKey);
    const text = `${this.translate.instant(item.labelKey)} ${words === wordsKey ? '' : words}`.toLowerCase();
    return q.split(/\s+/).every((w) => text.includes(w));
  }

  protected openFirst(): void {
    const first = this.sections()[0]?.items[0];
    if (first) void this.router.navigateByUrl(first.route);
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(e: KeyboardEvent): void {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return;
    e.preventDefault();
    this.filterInput()?.nativeElement.focus();
  }
}
