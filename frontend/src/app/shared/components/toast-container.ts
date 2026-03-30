import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-toast-container',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toast-container.html',
})
export class ToastContainerComponent {
  readonly toastService = inject(ToastService);
}
