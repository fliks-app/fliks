import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideEllipsisVertical, LucideHeart, LucideListPlus } from '@lucide/angular';
import { LikesApiService } from '../../../core/services/api/likes-api.service';
import { MediaType } from '../../../core/enums/media-type.enum';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { RecommendService } from '../../../core/services/recommend.service';
import { LikeController } from '../../../features/media-detail/like-controller';
import { AuthService } from '../../../core/services/auth.service';
import { CardActionsService, type CardAction } from '../../../core/services/card-actions.service';
import { DeviceService } from '../../../core/services/device.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { TvService } from '../../../core/services/tv.service';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import { resolveMediaAction, type MediaActionHandlers } from '../../../core/plugin-ui/media-action-registry';
import { resolveMenuContributions, type ResolvedMenuRow } from '../../../core/plugin-ui/resolve-menu-contributions';
import { MD_BREAKPOINT_QUERY, mediaQuerySignal } from '../../../core/utils/viewport';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { CORE_MEDIA_ACTIONS, sectionOf } from '../media-info-header/core-media-actions';
import { HeroPosterComponent } from '../hero-poster/hero-poster';
import { HeroProgressComponent } from '../hero-progress/hero-progress';
import { MobileFanartHeroComponent } from '../mobile-fanart-hero';
import { SynopsisComponent } from '../synopsis/synopsis';

/** Hero of a title with no video: blurred cover backdrop, cover, title, synopsis, progress and the shared like/playlist/recommend/more actions.
 *  The page projects its facts (`heroMeta`) and primary buttons (`heroActions`). */
@Component({
  selector: 'app-detail-hero',
  imports: [
    HeroPosterComponent,
    HeroProgressComponent,
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

  protected readonly navbar = inject(NavbarService);
  protected readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly pluginUi = inject(PluginUiRegistryService);
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

  protected toggleLike(): void {
    void this.like.toggle();
  }
  protected addToPlaylist(): void {
    this.playlists.open({ mediaId: this.mediaId() });
  }
  protected recommend(): void {
    this.recommendations.open({ mediaId: this.mediaId() });
  }

  private readonly handlers: MediaActionHandlers = {
    'media.toggle-like': () => this.toggleLike(),
    'media.add-to-playlist': () => this.addToPlaylist(),
    'media.recommend': () => this.recommend(),
  };

  private readonly menu = computed(() =>
    resolveMenuContributions({
      contributions: [
        ...CORE_MEDIA_ACTIONS,
        ...this.pluginUi.contributionsFor('media.actions'),
        ...this.pluginUi.contributionsFor('card.actions'),
      ],
      ctx: {
        isAdmin: this.auth.hasPermission('settings.access'),
        hasPermission: (p) => this.auth.hasPermission(p),
        mediaType: this.mediaType(),
        isTv: this.tv.isTv(),
        isTouch: this.device.isTouch(),
        surface: 'detail',
      },
      guards: { 'core.recommend': () => !this.auth.sharingDisabled() },
      resolveAction: (id) => resolveMediaAction(id, this.handlers),
      navigate: (path) => void this.router.navigate([path]),
    }),
  );

  protected openMenu(anchor: HTMLElement): void {
    const actions = this.menu().map((r) => this.toAction(r));
    if (!actions.length) return;
    this.cardActions.register({
      actions,
      anchor,
      title: this.title(),
      imageUrl: this.posterUrl(),
      placement: 'button',
    });
    this.cardActions.show();
  }

  private toAction(r: ResolvedMenuRow): CardAction {
    const toggle = r.actionId === 'media.toggle-like';
    return {
      labelKey: toggle ? (this.liked() ? 'media_detail.unlike' : 'media_detail.like') : r.labelKey,
      icon: r.icon,
      tone: r.tone,
      section: sectionOf(r.weight),
      ...(r.route ? { route: r.route } : {}),
      ...(r.children?.length ? { children: r.children.map((c) => this.toAction(c)) } : {}),
      run: () => r.run?.(),
    };
  }
}
