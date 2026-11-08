import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { TrackRow } from '../../core/services/api/music.models';
import { PlaylistsApiService, type Playlist } from '../../core/services/api/playlists-api.service';
import { KeyboardOverlayService } from '../../core/services/keyboard-overlay.service';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { playlistRows, trackRow, type NewRow } from './party-programme-items';

const SEARCH_DEBOUNCE_MS = 300;

/** Dialog for the music side of a programme: tracks by search, or a playlist (smart ones included) as its tracks. */
@Component({
  selector: 'app-party-music-picker',
  imports: [FormsModule, TranslatePipe, ModalHeaderComponent],
  templateUrl: './party-music-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyMusicPickerComponent implements OnDestroy {
  private readonly music = inject(MusicApiService);
  private readonly playlistsApi = inject(PlaylistsApiService);
  protected readonly keyboard = inject(KeyboardOverlayService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly picked = output<NewRow[]>();

  protected readonly tab = signal<'tracks' | 'playlists'>('tracks');
  protected readonly query = signal('');
  protected readonly tracks = signal<TrackRow[]>([]);
  protected readonly playlists = signal<Playlist[]>([]);
  protected readonly ticked = signal<ReadonlyMap<number, TrackRow>>(new Map());
  protected readonly busy = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  show(): void {
    const el = this.dialog()?.nativeElement;
    if (!el || el.open) return;
    this.tab.set('tracks');
    this.query.set('');
    this.tracks.set([]);
    this.ticked.set(new Map());
    this.keyboard.enter();
    el.showModal();
    void this.playlistsApi.list().then((l) => this.playlists.set(l)).catch(() => this.playlists.set([]));
  }

  protected close(): void {
    this.dialog()?.nativeElement.close();
  }

  protected onClosed(): void {
    clearTimeout(this.timer);
    this.seq++;
    this.keyboard.leave();
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    if (this.dialog()?.nativeElement.open) this.keyboard.leave();
  }

  protected search(q: string): void {
    this.query.set(q);
    clearTimeout(this.timer);
    const seq = ++this.seq;
    if (!q.trim()) return void this.tracks.set([]);
    this.timer = setTimeout(async () => {
      const rows = await this.music.tracks({ q: q.trim(), limit: 30 }).catch(() => []);
      if (seq === this.seq) this.tracks.set(rows.filter((t) => t.hasFile));
    }, SEARCH_DEBOUNCE_MS);
  }

  protected toggle(t: TrackRow): void {
    this.ticked.update((m) => {
      const next = new Map(m);
      if (!next.delete(t.itemId)) next.set(t.itemId, t);
      return next;
    });
  }

  protected confirm(): void {
    this.emit([...this.ticked().values()].map(trackRow));
  }

  protected async addPlaylist(p: Playlist): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      this.emit(playlistRows(await this.playlistsApi.items(p.id)));
    } catch {
      /* the error interceptor already toasted it */
    } finally {
      this.busy.set(false);
    }
  }

  private emit(rows: NewRow[]): void {
    if (rows.length) this.picked.emit(rows);
    this.close();
  }
}
