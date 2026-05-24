import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { DisplaySettingsService } from '../../../core/services/display-settings.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

@Component({
  selector: 'app-display-settings',
  imports: [TranslateModule, ToggleFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './display-settings.html',
})
export class DisplaySettingsPageComponent implements OnInit {
  private readonly displaySettings = inject(DisplaySettingsService);

  readonly homeBackground = signal(true);
  readonly onlyMyRequests = signal(false);

  ngOnInit() {
    const s = this.displaySettings.get();
    this.homeBackground.set(s.homeBackground);
    this.onlyMyRequests.set(s.onlyMyRequests);
  }

  onHomeBackgroundChange(value: boolean) {
    this.homeBackground.set(value);
    this.displaySettings.save({ homeBackground: value });
  }

  onOnlyMyRequestsChange(value: boolean) {
    this.onlyMyRequests.set(value);
    this.displaySettings.save({ onlyMyRequests: value });
  }
}
