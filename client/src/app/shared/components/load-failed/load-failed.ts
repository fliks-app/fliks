import { Component, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** Replaces a page's content when its initial load failed, with one way out. */
@Component({
  selector: 'app-load-failed',
  imports: [TranslatePipe],
  templateUrl: './load-failed.html',
})
export class LoadFailedComponent {
  readonly message = input.required<string>();
  readonly retry = output<void>();
}
