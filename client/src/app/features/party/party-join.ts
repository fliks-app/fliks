import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PartyService } from '../../core/services/party/party.service';

/** `/party/:token`: resolves the invite link, joins, and opens the player on the party item. */
@Component({
  selector: 'app-party-join',
  imports: [TranslatePipe],
  templateUrl: './party-join.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyJoinComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly party = inject(PartyService);
  protected readonly failed = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      await this.party.openByToken(this.route.snapshot.params['token']);
    } catch {
      this.failed.set(true);
    }
  }

  protected home(): void {
    void this.router.navigateByUrl('/');
  }
}
