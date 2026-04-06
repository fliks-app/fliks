import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MetadataSearchResult } from '../../../core/services/api/metadata.service';
import { LucideFilm, LucideCheck, LucideClock, LucideX } from '@lucide/angular';

export type CardStatus = 'library' | 'pending' | 'declined' | null;

@Component({
  selector: 'app-discover-card',
  imports: [DecimalPipe, LucideFilm, LucideCheck, LucideClock, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './discover-card.component.html',
})
export class DiscoverCardComponent {
  readonly row = input.required<MetadataSearchResult>();
  readonly status = input<CardStatus>(null);
  readonly clicked = output<MetadataSearchResult>();
}
