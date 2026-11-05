import { Component, InjectionToken, computed, inject, input, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideEllipsisVertical, LucideHeart, LucideListPlus } from '@lucide/angular';
import { MediaAdminService } from '../../../core/services/media-admin.service';
import type { Media } from '../../../core/services/api/media.service';
import { MediaLibraryDialogComponent } from '../media-library-dialog/media-library-dialog';
import { LikesApiService } from '../../../core/services/api/likes-api.service';
import { MediaType } from '../../../core/enums/media-type.enum';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { RecommendService } from '../../../core/services/recommend.service';
import { LikeController } from '../../utils/like-controller';
import { AuthService } from '../../../core/services/auth.service';
import { CardActionsService } from '../../../core/services/card-actions.service';
import { DeviceService } from '../../../core/services/device.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { TvService } from '../../../core/services/tv.service';
import type { CoreMediaActionId, MediaActionHandlers } from '../../../core/plugin-ui/media-action-registry';
import { MD_BREAKPOINT_QUERY, mediaQuerySignal } from '../../../core/utils/viewport';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { CORE_MEDIA_ACTIONS } from '../media-info-header/core-media-actions';
import { openMediaMenu } from '../../utils/media-menu';
import { MediaActionsController } from '../../utils/media-actions-controller';
import { hasProviderId } from '../../../core/utils/media-identity';
import { HeroPosterComponent } from '../hero-poster/hero-poster';
import { HeroProgressComponent } from '../hero-progress/hero-progress';
import { MobileFanartHeroComponent } from '../mobile-fanart-hero';
import { SynopsisComponent } from '../synopsis/synopsis';

/** The page that owns the title shown here; told when the library dialog saved a new version of it. */
export interface MediaSavedHost {
  onLibrarySaved(updated: Media): void;
}
export const MEDIA_SAVED_HOST = new InjectionToken<MediaSavedHost>('MEDIA_SAVED_HOST');

/** Hero of a title with no video: blurred cover backdrop, cover, title, synopsis, progress and the shared like/playlist/recommend/more actions.
 *  The page projects its facts (`heroMeta`) and primary buttons (`heroActions`). */
@Component({
  selector: 'app-detail-hero',
  imports: [
    HeroPosterComponent,
    HeroProgressComponent,
    MediaLibraryDialogComponent,
    MobileFanartHeroComponent,
    SynopsisComponent,
    TranslatePipe,
    TvRowDirective,
    LucideEllipsisVertical,
    LucideHeart,
    LucideListPlus,
  ],
  templateUrl: './detail-hero.html',
  host: { class: 'block' },
})
export class DetailHeroComponent {
  readonly title = input.required<string>();
  readonly mediaId = input.required<number>();
  readonly mediaType = input.required<MediaType>();
  readonly posterUrl = input<string | null>(null);
  readonly overview = input<string | null>(null);
  readonly progressPercent = input(0);
  readonly progressLabel = input<string | null>(null);
  /** The full row: enables the shared admin entries (identify, refresh, library, delete). */
  readonly media = input<Media | null>(null);
  /** The page's own handlers; they win over the shared ones. */
  readonly actions = input<MediaActionHandlers>({});
  /** Shared entries this kind does not support. */
  readonly exclude = input<CoreMediaActionId[]>([]);

  private readonly host = inject(MEDIA_SAVED_HOST, { optional: true });

  protected readonly navbar = inject(NavbarService);
  protected readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  private readonly auth = inject(AuthService);
  private readonly cardActions = inject(CardActionsService);
  private readonly mdUp = mediaQuerySignal(MD_BREAKPOINT_QUERY);
  protected readonly desktopLayout = computed(() => this.device.isTv() || this.mdUp());
  protected readonly viewTransitionName = computed(() => 'media-poster-' + this.mediaId());

  private readonly like = new LikeController(
    { media: () => ({ id: this.mediaId() }), episodeMode: () => false, focusedEpisode: () => null },
    inject(LikesApiService),
  );
  protected readonly liked = this.like.focusedLiked;
  private readonly playlists = inject(AddToPlaylistService);
  private readonly recommendations = inject(RecommendService);

  protected onLibrarySaved(updated: Media): void {
    this.host?.onLibrarySaved(updated);
  }

  protected toggleLike(): void {
    void this.like.toggle();
  }
  protected addToPlaylist(): void {
    this.playlists.open({ mediaId: this.mediaId() });
  }
  protected recommend(): void {
    this.recommendations.open({ mediaId: this.mediaId() });
  }

  private readonly admin = inject(MediaAdminService);
  private readonly libraryDialog = viewChild(MediaLibraryDialogComponent);

  private readonly handlers = computed<MediaActionHandlers>(() => {
    const m = this.media();
    const shared: MediaActionHandlers = {
      'media.toggle-like': () => this.toggleLike(),
      'media.add-to-playlist': () => this.addToPlaylist(),
      'media.recommend': () => this.recommend(),
      ...(m && {
        'media.identify': () => this.admin.identify(m),
        'media.refresh-metadata': () => void this.admin.refreshMetadata(m.id),
        'media.edit-library': () => this.libraryDialog()?.open(),
        'media.delete': () => void this.admin.deleteMedia(m),
      }),
    };
    for (const id of this.exclude()) delete shared[id];
    return { ...shared, ...this.actions() };
  });

  private readonly identified = computed(() => {
    const m = this.media();
    return !!m && (hasProviderId(m) || !!m.providers?.length || !!m.externalIds?.length);
  });

  /** A book's profiles are its wanted formats and languages. */
  private readonly rowOverrides = (r: { actionId?: string; labelKey: string }) => {
    if (r.actionId === 'media.toggle-like') return { labelKey: this.liked() ? 'media_detail.unlike' : 'media_detail.like' };
    if (r.actionId === 'media.edit-profiles' && this.mediaType() === 'book') return { labelKey: 'books_work.edit_profiles' };
    return { disabled: this.actionsMenu.isDisabled(r.actionId) };
  };

  private readonly actionsMenu = new MediaActionsController({
    base: () => ({ mediaId: this.mediaId(), kind: this.mediaType(), level: 'work' }),
    facts: () => ({ isAdmin: this.auth.hasPermission('settings.access'), hasFiles: false, identified: this.identified() }),
    core: CORE_MEDIA_ACTIONS,
    handlers: () => this.handlers(),
    guards: { 'core.recommend': () => !this.auth.sharingDisabled() },
  });

  protected openMenu(anchor: HTMLElement): void {
    openMediaMenu(
      this.cardActions,
      this.actionsMenu.rows(),
      anchor,
      { title: this.title(), imageUrl: this.posterUrl() },
      this.rowOverrides,
    );
  }
}
