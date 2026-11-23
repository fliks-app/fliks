import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ProblemsService } from '../../../core/services/api/problems.service';
import { TvRowDirective } from '../../../shared/directives/tv-row.directive';
import { ModalComponent } from '../../../shared/components/modal';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import type { ProblemResolveMode } from '../problem-card/problem-card';

const CHIPS: Record<ProblemResolveMode, readonly string[]> = {
  resolve: ['new_file', 'subtitles_replaced', 'cannot_reproduce'],
  close: ['cannot_reproduce', 'not_a_defect', 'duplicate'],
};

/** Mark fixed (optional reply) or close (reason required) in one call; a failure keeps the dialog open. */
@Component({
  selector: 'app-problem-resolve-dialog',
  imports: [ModalComponent, TvRowDirective, ModalFooterComponent, ModalHeaderComponent, FormsModule, TranslatePipe],
  templateUrl: './problem-resolve-dialog.html',
})
export class ProblemResolveDialogComponent {
  private readonly api = inject(ProblemsService);
  private readonly translate = inject(TranslateService);

  readonly problemId = input<number | null>(null);
  readonly mode = input<ProblemResolveMode>('resolve');
  readonly done = output<void>();

  protected readonly text = signal('');
  protected readonly busy = signal(false);
  protected readonly chips = () => CHIPS[this.mode()].map((k) => `problems.resolve.chip_${k}`);
  private readonly dialogEl = viewChild<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });

  protected pick(key: string) {
    this.text.set(this.translate.instant(key));
  }

  protected isPicked(key: string) {
    return this.text() === this.translate.instant(key);
  }

  protected canSubmit() {
    return !this.busy() && (this.mode() === 'resolve' || this.text().trim().length > 0);
  }

  async submit() {
    const id = this.problemId();
    if (id == null || !this.canSubmit()) return;
    const text = this.text().trim();
    this.busy.set(true);
    try {
      await (this.mode() === 'resolve' ? this.api.resolve(id, text) : this.api.close(id, text));
    } catch {
      return;
    } finally {
      this.busy.set(false);
    }
    this.close();
    this.done.emit();
  }

  showModal() {
    this.text.set('');
    this.dialogEl()?.nativeElement.showModal();
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }
}
