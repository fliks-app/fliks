import { Component, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { MediaCastEntry } from '../../../../core/services/api/media.service';
import type { MetadataCredit } from '../../../../core/services/api/metadata.service';
import { ResolveUrlPipe } from '../../../../core/pipes/resolve-url.pipe';
import { armPageSlide } from '../../../../shared/utils/page-slide';
import { CachedSrcDirective } from '../../../../shared/directives/cached-src.directive';
import { ImgFadeInDirective } from '../../../../shared/directives/img-fade-in.directive';
import { DetailSectionComponent } from '../../../../shared/components/detail-section/detail-section';
import { HorizontalScrollerComponent } from '../../../../shared/components/horizontal-scroller';

/** A person of the row; `link` is their page in the library, none for a title that is only previewed. */
export interface CastMember {
  key: number | string;
  name: string;
  character: string | null;
  avatarUrl: string | null;
  link: string[] | null;
}

export const libraryCast = (cast: MediaCastEntry[]): CastMember[] =>
  cast.map((c) => ({ key: c.id, name: c.person.name, character: c.character || null, avatarUrl: c.person.avatarUrl, link: ['/persons', String(c.person.id)] }));

export const providerCast = (cast: MetadataCredit[]): CastMember[] =>
  cast.map((c) => ({ key: c.externalId, name: c.name, character: c.character || null, avatarUrl: c.avatarUrl ?? null, link: null }));

/** The cast row of a title's detail page; nothing, divider included, when the cast is empty. */
@Component({
  selector: 'app-media-cast',
  imports: [NgTemplateOutlet, RouterLink, TranslatePipe, ResolveUrlPipe, CachedSrcDirective, ImgFadeInDirective, DetailSectionComponent, HorizontalScrollerComponent],
  templateUrl: './media-cast.component.html',
  host: { class: 'cv-auto py-5 -my-5 px-4 -mx-4', '[class.hidden]': '!cast().length', style: 'contain-intrinsic-size: auto 12rem' },
})
export class MediaCastComponent {
  readonly cast = input.required<CastMember[]>();
  readonly headingKey = input('media_detail.cast');
  readonly persistKey = input('cast');

  /** A bare `routerLink` has nothing that arms the page slide, unlike a card. */
  protected readonly armSlide = armPageSlide;
}
