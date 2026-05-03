import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { ToastService } from '../../core/services/toast.service';
import {
  LucideCircleCheck,
  LucideCircleX,
  LucideTriangleAlert,
  LucideInfo,
  LucideX,
} from '@lucide/angular';

@Component({
  selector: 'app-toast-container',
  imports: [TranslateModule, LucideCircleCheck, LucideCircleX, LucideTriangleAlert, LucideInfo, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toast-container.html',
})
export class ToastContainerComponent {
  readonly toastService = inject(ToastService);
}
