import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ConfirmationService } from '../../../core/services/confirmation.service';

interface DelayProfileRow {
  id: number;
  torrentDelay: number;
  order: number;
  tags: { id: number; label: string }[];
}

@Component({
  selector: 'app-delay-profiles',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './delay-profiles.html',
})
export class DelayProfilesComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly rows = signal<DelayProfileRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingId = signal<number | null>(null);

  readonly formDelay = signal(6);
  readonly formOrder = signal(1);

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    this.listError.set('');
    try {
      const list = await firstValueFrom(this.http.get<DelayProfileRow[]>('/api/profiles/delay'));
      this.rows.set(list);
    } catch {
      this.listError.set(this.translate.instant('settings.delay_profiles.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.editingId.set(null);
    this.formDelay.set(6);
    this.formOrder.set(1);
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(row: DelayProfileRow) {
    this.editingId.set(row.id);
    this.formDelay.set(row.torrentDelay);
    this.formOrder.set(row.order);
    this.saveError.set('');
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  async save() {
    this.saving.set(true);
    this.saveError.set('');
    const body = {
      torrentDelay: this.formDelay(),
      order: this.formOrder(),
      tagIds: [] as number[],
    };
    const id = this.editingId();
    try {
      if (id == null) {
        await firstValueFrom(this.http.post('/api/profiles/delay', body));
      } else {
        await firstValueFrom(this.http.put(`/api/profiles/delay/${id}`, body));
      }
      this.closeEditor();
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.saveError.set(httpErr.error?.message ?? this.translate.instant('settings.delay_profiles.save_error'));
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRow(row: DelayProfileRow) {
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: this.translate.instant('settings.delay_profiles.confirm_delete'), variant: 'danger' })) return;
    try {
      await firstValueFrom(this.http.delete(`/api/profiles/delay/${row.id}`));
      await this.reloadAll();
    } catch {
      // ignore
    }
  }
}
