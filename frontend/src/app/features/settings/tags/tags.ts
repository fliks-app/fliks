import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { TagsApiService, Tag } from '../../../core/services/api/tags-api.service';

@Component({
  selector: 'app-tags-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tags.html',
})
export class TagsSettingsComponent implements OnInit {
  private readonly api = inject(TagsApiService);
  private readonly translate = inject(TranslateService);

  readonly tags = signal<Tag[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly newLabel = signal('');
  readonly adding = signal(false);
  readonly addError = signal('');

  readonly editingId = signal<number | null>(null);
  readonly editLabel = signal('');

  ngOnInit() {
    this.reload();
  }

  async reload() {
    this.loading.set(true);
    try {
      const list = await this.api.list();
      this.tags.set(list);
    } catch {
      this.listError.set(this.translate.instant('settings.tags.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  async add() {
    const label = this.newLabel().trim();
    if (!label) return;
    this.adding.set(true);
    this.addError.set('');
    try {
      const tag = await this.api.create(label);
      this.tags.update((t) => [...t, tag]);
      this.newLabel.set('');
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.addError.set(msg ?? this.translate.instant('settings.tags.add_error'));
    } finally {
      this.adding.set(false);
    }
  }

  startEdit(tag: Tag) {
    this.editingId.set(tag.id);
    this.editLabel.set(tag.label);
  }

  cancelEdit() {
    this.editingId.set(null);
  }

  async saveEdit(tag: Tag) {
    const label = this.editLabel().trim();
    if (!label) return;
    try {
      const updated = await this.api.update(tag.id, label);
      this.tags.update((list) => list.map((t) => (t.id === updated.id ? updated : t)));
      this.editingId.set(null);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      alert(httpErr.error?.message ?? this.translate.instant('settings.tags.save_error'));
    }
  }

  async remove(tag: Tag) {
    if (!confirm(this.translate.instant('settings.tags.confirm_delete', { label: tag.label }))) return;
    try {
      await this.api.remove(tag.id);
      this.tags.update((list) => list.filter((t) => t.id !== tag.id));
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      alert(httpErr.error?.message ?? 'Error');
    }
  }
}
