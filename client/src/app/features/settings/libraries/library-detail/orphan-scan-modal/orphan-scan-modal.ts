import { Component, ElementRef, output, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ModalHeaderComponent } from '../../../../../shared/components/modal-header';
import { OrphanScanPanelComponent } from '../orphan-scan-panel/orphan-scan-panel';
import { ModalComponent } from '../../../../../shared/components/modal';

@Component({
  selector: 'app-orphan-scan-modal',
  imports: [ModalComponent, TranslatePipe, ModalHeaderComponent, OrphanScanPanelComponent],
  templateUrl: './orphan-scan-modal.html',
})
export class OrphanScanModalComponent {
  readonly linked = output<void>();

  private readonly dialogEl = viewChild<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });
  private readonly panel = viewChild<OrphanScanPanelComponent>('panel');

  async open(libraryId: number) {
    this.dialogEl()?.nativeElement.showModal();
    await this.panel()?.scanLibrary(libraryId);
  }

  close() {
    this.dialogEl()?.nativeElement.close();
  }

  // Escape closes the dialog natively, without going through close().
  onClosed() {
    if (this.panel()?.anyLinked()) this.linked.emit();
  }
}
