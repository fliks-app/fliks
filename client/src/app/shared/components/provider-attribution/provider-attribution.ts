import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { MediaProvider } from '../../../core/services/api/media.service';

/** What a title's sources owe: a link back to each plugin that served it, a note for unofficial sources. */
@Component({
  selector: 'app-provider-attribution',
  imports: [TranslatePipe],
  templateUrl: './provider-attribution.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProviderAttributionComponent {
  readonly providers = input<MediaProvider[] | undefined>();

  protected readonly linked = computed(() => (this.providers() ?? []).filter((p) => !!p.url));
  protected readonly unofficial = computed(() => (this.providers() ?? []).some((p) => p.unofficial));
}
