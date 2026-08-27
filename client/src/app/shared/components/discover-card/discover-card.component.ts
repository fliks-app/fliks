import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MetadataSearchResult } from '../../../core/services/api/metadata.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { LucideFilm, LucideCheck, LucideClock, LucideX } from '@lucide/angular';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

export type CardStatus = 'library' | 'pending' | 'declined' | null;

@Component({
  selector: 'app-discover-card',
  imports: [
    CachedSrcDirective,DecimalPipe, ResolveUrlPipe, LucideFilm, LucideCheck, LucideClock, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './discover-card.component.html',
})
export class DiscoverCardComponent {
  readonly row = input.required<MetadataSearchResult>();
  readonly status = input<CardStatus>(null);
  readonly clicked = output<MetadataSearchResult>();
}
