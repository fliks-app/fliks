import { ChangeDetectionStrategy, Component, ElementRef, output, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { ModalHeaderComponent } from '../../../../../shared/components/modal-header';
import { OrphanScanPanelComponent } from '../orphan-scan-panel/orphan-scan-panel';
import { ModalFooterComponent } from '../../../../../shared/components/modal-footer';

@Component({
  selector: 'app-orphan-scan-modal',
  imports: [ModalFooterComponent, TranslatePipe, ModalHeaderComponent, OrphanScanPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './orphan-scan-modal.html',
})
export class OrphanScanModalComponent {
  readonly linked = output<void>();

  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly panel = viewChild<OrphanScanPanelComponent>('panel');

  async open(libraryId: number) {
    this.dialogEl()?.nativeElement.showModal();
    await this.panel()?.scanLibrary(libraryId);
  }

  close() {
    this.dialogEl()?.nativeElement.close();
    if (this.panel()?.anyLinked()) this.linked.emit();
  }
}
