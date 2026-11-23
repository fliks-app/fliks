import { Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../../shared/icons';
import { translatePlural } from '../../../core/pipes/translate-plural.pipe';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';
import { FliksRequestDetail, RequestsService } from '../../../core/services/api/requests.service';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { UserAvatarComponent } from '../../../shared/components/user-avatar/user-avatar';
import { ModalComponent } from '../../../shared/components/modal';

/** Manager-only line "Requested by Ana and 1 other"; a tap lists the requester and the watchers with their dates. */
@Component({
  selector: 'app-request-requesters',
  imports: [ModalComponent, TranslatePipe, LocaleDatePipe, ModalHeaderComponent, UserAvatarComponent, LucideDynamicIcon],
  templateUrl: './request-requesters.component.html',
  host: { class: 'block' },
})
export class RequestRequestersComponent {
  protected readonly icons = icons;

  private readonly requests = inject(RequestsService);
  private readonly translate = inject(TranslateService);

  readonly requestId = input.required<number>();
  /** Any change refetches the detail (the host bumps it after a watch or an approval). */
  readonly version = input<unknown>(null);
  readonly loaded = output<FliksRequestDetail>();

  protected readonly detail = signal<FliksRequestDetail | null>(null);
  private readonly sheet = viewChild<string, ElementRef<HTMLDialogElement>>('sheet', { read: ElementRef });

  protected readonly people = computed(() => {
    const d = this.detail();
    if (!d) return [];
    return [
      { id: d.user.id, username: d.user.username, avatar: null as string | null, requester: true, at: d.createdAt },
      ...(d.watchers ?? []).map((w) => ({ id: w.id, username: w.username, avatar: w.avatar ?? null, requester: false, at: w.createdAt })),
    ];
  });

  protected readonly line = computed(() => {
    const d = this.detail();
    if (!d) return '';
    const others = d.watchers?.length ?? 0;
    return others
      ? translatePlural(this.translate, 'requests.requested_by_and_others', others, { name: d.user.username })
      : this.translate.instant('requests.requested_by_name', { name: d.user.username });
  });

  constructor() {
    effect(() => {
      this.version();
      this.requests
        .get(this.requestId())
        .then((d) => {
          this.detail.set(d);
          this.loaded.emit(d);
        })
        .catch(() => this.detail.set(null));
    });
  }

  protected open() {
    this.sheet()?.nativeElement.showModal();
  }

  protected close() {
    this.sheet()?.nativeElement.close();
  }
}
