import { Component, ChangeDetectionStrategy, signal, inject, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { LucideShield, LucideCast, LucideRadio } from '@lucide/angular';

const DEFAULT_RANGES = `192.168.0.0/16
10.0.0.0/8
172.16.0.0/12
127.0.0.1/32`;

const CAST_ROUTES = [
  { method: 'POST', path: '/api/auth/cast-info', description: 'Obtention du token Chromecast' },
  { method: 'GET', path: '/api/stream/:id/master.m3u8', description: 'Playlist HLS principale' },
  { method: 'GET', path: '/api/stream/:id/:quality/index.m3u8', description: 'Playlist HLS par qualité' },
  { method: 'GET', path: '/api/stream/:id/:quality/seg-*.ts', description: 'Segments vidéo transcodés' },
  { method: 'GET', path: '/api/stream/:id', description: 'Lecture directe (DirectPlay)' },
  { method: 'GET', path: '/api/stream/:id/subtitles/*', description: 'Sous-titres (WebVTT)' },
  { method: 'GET', path: '/api/images/*', description: 'Affiches et images' },
  { method: 'DELETE', path: '/api/stream/:id/sessions', description: 'Fermeture de session' },
];

@Component({
  selector: 'app-network-settings',
  standalone: true,
  imports: [FormsModule, TranslateModule, LucideShield, LucideCast, LucideRadio],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './network.html',
})
export class NetworkSettingsComponent implements OnInit, OnDestroy {
  private readonly settingsApi = inject(SettingsApiService);
  private readonly toast = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);

  readonly castRoutes = CAST_ROUTES;
  readonly enabled = signal<'false' | 'pending' | 'true'>('false');
  readonly exposeCast = signal(false);
  readonly ranges = signal(DEFAULT_RANGES);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly myIp = signal<string | null>(null);
  readonly myIpv6 = signal<string | null>(null);

  // Confirmation countdown
  readonly countdown = signal(0);
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit() {
    try {
      const all = await this.settingsApi.getAll();
      this.enabled.set((all['ip_whitelist_enabled'] as any) ?? 'false');
      this.exposeCast.set(all['ip_whitelist_expose_cast'] === 'true');
      const raw = all['ip_whitelist_ranges'];
      if (raw) {
        try {
          const arr: string[] = JSON.parse(raw);
          this.ranges.set(arr.join('\n'));
        } catch { /* keep default */ }
      }
    } catch { /* keep defaults */ }
    this.loading.set(false);
  }

  ngOnDestroy() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
  }

  async activate() {
    this.saving.set(true);
    const rangesArray = this.ranges()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (!rangesArray.length) {
      this.toast.error('Ajoutez au moins un range IP');
      this.saving.set(false);
      return;
    }

    const pendingUntil = new Date(Date.now() + 30_000).toISOString();
    try {
      await this.settingsApi.setBulk({
        ip_whitelist_enabled: 'pending',
        ip_whitelist_ranges: JSON.stringify(rangesArray),
        ip_whitelist_expose_cast: this.exposeCast() ? 'true' : 'false',
        ip_whitelist_pending_until: pendingUntil,
      });
      this.enabled.set('pending');
      this.startCountdown();
    } catch {
      this.toast.error('Erreur lors de l\'activation');
    }
    this.saving.set(false);
  }

  async confirm() {
    try {
      await this.settingsApi.setBulk({
        ip_whitelist_enabled: 'true',
        ip_whitelist_pending_until: null,
      });
      this.enabled.set('true');
      this.stopCountdown();
      this.toast.success('Restriction IP activée');
    } catch {
      this.toast.error('Erreur — la restriction a peut-être été révoquée');
      this.enabled.set('false');
      this.stopCountdown();
    }
  }

  async deactivate() {
    try {
      await this.settingsApi.setBulk({
        ip_whitelist_enabled: 'false',
        ip_whitelist_pending_until: null,
      });
      this.enabled.set('false');
      this.stopCountdown();
      this.toast.success('Restriction IP désactivée');
    } catch {
      this.toast.error('Erreur lors de la désactivation');
    }
  }

  private startCountdown() {
    this.countdown.set(30);
    this.countdownTimer = setInterval(() => {
      const v = this.countdown() - 1;
      this.countdown.set(v);
      if (v <= 0) {
        this.stopCountdown();
        this.enabled.set('false');
        this.toast.error('Confirmation expirée — restriction désactivée automatiquement');
      }
    }, 1000);
  }

  async saveSettings() {
    const rangesArray = this.ranges()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    try {
      await this.settingsApi.setBulk({
        ip_whitelist_ranges: JSON.stringify(rangesArray),
        ip_whitelist_expose_cast: this.exposeCast() ? 'true' : 'false',
      });
      this.toast.success('Paramètres enregistrés');
    } catch {
      this.toast.error('Erreur lors de la sauvegarde');
    }
  }

  resetDefaults() {
    this.ranges.set(DEFAULT_RANGES);
  }

  async fetchMyIp() {
    try {
      const res = await this.settingsApi.getMyIp();
      this.myIp.set(res.ip);
      this.myIpv6.set(res.ipv6 ?? null);
    } catch {
      this.toast.error('Impossible de récupérer l\'IP');
    }
  }

  private stopCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.countdown.set(0);
  }
}
