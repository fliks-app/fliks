import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { oidcErrorText } from '../../core/services/oidc';
import { ToastService } from '../../core/services/toast.service';

/** Landing page of the provider callback: `code` and `state` (or `error`) arrive in the fragment. */
@Component({
  selector: 'app-oidc-complete',
  imports: [TranslatePipe],
  templateUrl: './oidc-complete.html',
})
export class OidcCompleteComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  async ngOnInit(): Promise<void> {
    const { fragment, queryParamMap } = this.route.snapshot;
    const params = new URLSearchParams(fragment ?? '');
    const get = (k: string) => params.get(k) ?? queryParamMap.get(k);
    const [code, state, error] = [get('code'), get('state'), get('error')];

    const res =
      error || !code || !state
        ? await this.auth.oidcReturned({ error: error ?? 'expired' }, state ?? undefined)
        : await this.auth.oidcReturned({ code, state });

    if (res.ok) {
      await this.router.navigate([res.pending.link ? '/account' : '/'], { replaceUrl: true });
      return;
    }
    // Back from the app to the provider's page and on to a spent state: the sign-in already worked.
    if (res.kind === 'expired' && !res.pending?.link && this.auth.user()) {
      await this.router.navigate(['/'], { replaceUrl: true });
      return;
    }
    if (res.pending?.link) {
      this.toast.error(oidcErrorText(this.translate, res.kind));
      await this.router.navigate(['/account'], { replaceUrl: true });
      return;
    }
    await this.router.navigate(['/login'], {
      replaceUrl: true,
      queryParams: { autoLaunch: 0, ...(res.pending?.silent ? {} : { oidcError: res.kind }) },
    });
  }
}
