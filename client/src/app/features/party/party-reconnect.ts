import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PartyService } from '../../core/services/party/party.service';
import { BlockingOverlayComponent } from '../../shared/components/blocking-overlay/blocking-overlay';

/** Maps `PartyService.reconnecting` to the blocking overlay; mounted once in the layout. */
@Component({
  selector: 'app-party-reconnect',
  imports: [TranslatePipe, BlockingOverlayComponent],
  templateUrl: './party-reconnect.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyReconnectComponent {
  protected readonly party = inject(PartyService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  protected readonly actions = computed(() => [{ label: this.translate.instant('party.leave'), run: () => void this.leave() }]);

  private async leave(): Promise<void> {
    try {
      if (await this.party.leaveOrEnd()) void this.router.navigateByUrl('/');
    } catch {
      /* a host's end needs the server: the interceptor already said it is unreachable */
    }
  }
}
