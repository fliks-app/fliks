import { Component, effect, inject, viewChild } from '@angular/core';
import { IdentifyModalService } from '../../../core/services/identify-modal.service';
import { MediaDetailIdentifyModalComponent } from '../../../features/media-detail/components/media-detail-identify-modal/media-detail-identify-modal.component';

/** Mounts the identify dialog once, at the layout, driven by its service. */
@Component({
  selector: 'app-identify-modal-host',
  standalone: true,
  imports: [MediaDetailIdentifyModalComponent],
  template: `<app-media-detail-identify-modal (identified)="service.markIdentified()" />`,
})
export class IdentifyModalHostComponent {
  protected readonly service = inject(IdentifyModalService);
  private readonly modal = viewChild(MediaDetailIdentifyModalComponent);

  constructor() {
    effect(() => {
      const req = this.service.request();
      const modal = this.modal();
      if (!req || !modal) return;
      this.service.clear();
      modal.open(req.config);
    });
  }
}
