import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { serverMessage } from '../../core/utils/server-message';
import type { OpenReleases } from '../../shared/components/data-table/data-table.types';
import type { ReleasesModalComponent } from '../media-detail/components/releases-modal/releases-modal.component';
import type { MovieRelease } from '../media-detail/media-detail-release-picker.service';
import {
  isUnprofiledReleaseError,
  releaseGrabBody,
} from '../media-detail/media-detail-release.utils';
import {
  ReleaseSearchStreamService,
  type IndexerRosterEntry,
} from '../media-detail/release-search-stream.service';

const RELEASES_EMPTY = 'media_detail.releases_empty';

interface OpenPicker {
  search: string;
  grab: string;
  grabbed: () => void;
}

/** The release picker of a table row (`releases` row action): the row's own routes, no want to choose. */
@Injectable()
export class RowReleasePicker {
  private readonly http = inject(HttpClient);
  private readonly stream = inject(ReleaseSearchStreamService);
  private readonly translate = inject(TranslateService);

  private modal: () => ReleasesModalComponent | undefined = () => undefined;
  private pluginId: () => string = () => '';
  private current: OpenPicker | null = null;

  readonly titleKey = signal('');
  readonly releases = signal<MovieRelease[]>([]);
  readonly indexers = signal<IndexerRosterEntry[]>([]);
  readonly loading = signal(false);
  readonly searched = signal(false);
  readonly error = signal('');
  readonly emptyMessage = signal(RELEASES_EMPTY);
  readonly grabBusy = signal<string | null>(null);
  readonly grabState = signal<Map<string, 'ok' | 'error'>>(new Map());

  attach(modal: () => ReleasesModalComponent | undefined, pluginId: () => string): void {
    this.modal = modal;
    this.pluginId = pluginId;
  }

  readonly open: OpenReleases = (picker, grabbed) => {
    void this.run({ search: picker.search, grab: picker.grab, grabbed }, picker.titleKey);
  };

  private async run(open: OpenPicker, titleKey: string): Promise<void> {
    this.current = open;
    this.titleKey.set(titleKey);
    this.releases.set([]);
    this.indexers.set([]);
    this.searched.set(false);
    this.error.set('');
    this.emptyMessage.set(RELEASES_EMPTY);
    this.grabState.set(new Map());
    this.loading.set(true);
    this.modal()?.showModal();
    try {
      const search = {
        pluginId: this.pluginId(),
        name: this.pluginId(),
        fetch: (sid: string) => firstValueFrom(this.http.get<MovieRelease[]>(open.search, { params: { sid } })),
      };
      const rows = await this.stream.run([search], { releases: this.releases, indexers: this.indexers });
      if (this.current === open) this.releases.set(rows);
    } catch (err: unknown) {
      if (this.current !== open) return;
      this.releases.set([]);
      if (isUnprofiledReleaseError(err)) this.emptyMessage.set('media_detail.no_quality_profile');
      else this.error.set(serverMessage(err, this.translate, 'media_detail.releases_error'));
    } finally {
      if (this.current === open) {
        this.searched.set(true);
        this.loading.set(false);
      }
    }
  }

  /** The row is gone once a release replaces it, so the modal closes with it; a failure is toasted by the interceptor. */
  async grab(r: MovieRelease, key: string): Promise<void> {
    const open = this.current;
    if (!open) return;
    this.grabBusy.set(key);
    try {
      await firstValueFrom(this.http.post(open.grab, releaseGrabBody(r)));
      this.modal()?.close();
      open.grabbed();
    } catch {
      this.grabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.grabBusy.set(null);
    }
  }
}
