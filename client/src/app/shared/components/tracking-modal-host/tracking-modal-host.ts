import { Component, effect, inject, viewChild } from '@angular/core';
import { TrackingModalService } from '../../../core/services/tracking-modal.service';
import { TrackingStatusModalComponent } from '../tracking-status-modal/tracking-status-modal';

/**
 * Mounts the tracking dialog once, at the layout, and opens it from
 * {@link TrackingModalService}. Kept as its own component so the layout stays a
 * layout and the modal stays unaware of who asked for it.
 */
@Component({
  selector: 'app-tracking-modal-host',
  standalone: true,
  imports: [TrackingStatusModalComponent],
  template: `<app-tracking-status-modal />`,
})
export class TrackingModalHostComponent {
  private readonly service = inject(TrackingModalService);
  private readonly modal = viewChild(TrackingStatusModalComponent);

  constructor() {
    effect(() => {
      const req = this.service.request();
      const modal = this.modal();
      if (!req || !modal) return;
      this.service.clear();
      void modal.open(req.mediaId, req.scope);
    });
  }
}
