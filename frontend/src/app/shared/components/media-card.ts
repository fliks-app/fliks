import { Component, ChangeDetectionStrategy, input, output, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgClass, DecimalPipe } from '@angular/common';
import { LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideX, LucideCircleCheck, LucideCircleX } from '@lucide/angular';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

export type MediaCardAspect = 'portrait' | 'landscape';

export type BarStatus =
  | 'downloaded-monitored'
  | 'downloaded-unmonitored'
  | 'missing-monitored'
  | 'missing-unmonitored'
  | 'unreleased'
  | 'queued';

export type CardBadge = 'library' | 'pending' | 'declined' | null;
export type CardStatus = 'watched' | 'missing' | null;

@Component({
  selector: 'app-media-card',
  imports: [RouterLink, NgClass, DecimalPipe, ResolveUrlPipe,
    LucideFilm, LucidePlay, LucideStar, LucideCheck, LucideClock, LucideX, LucideCircleCheck, LucideCircleX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="relative"
      [class.opacity-55]="dimmed()"
      [class]="aspect() === 'landscape' ? 'shrink-0 w-56 sm:w-64' : ''"
    >
      <!-- Image -->
      <figure
        class="group relative bg-base-300 rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-shadow cursor-pointer"
        [class.aspect-2/3]="aspect() === 'portrait'"
        [class.aspect-video]="aspect() === 'landscape'"
        (click)="clicked.emit()"
      >
        @if (imageUrl()) {
          <img
            [src]="imageUrl()! | resolveUrl"
            [alt]="title()"
            class="w-full h-full object-cover"
            [class.opacity-35]="imageBlurred()"
            [class.scale-105]="imageBlurred()"
            loading="lazy"
          />
        } @else {
          <div class="flex items-center justify-center w-full h-full text-base-content/20">
            <svg lucideFilm class="h-12 w-12" [strokeWidth]="1.5"></svg>
          </div>
        }

        <!-- Rating badge (bottom-left, portrait only) -->
        @if (rating() > 0 && aspect() === 'portrait') {
          <div class="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 bg-black/60 rounded-md px-1.5 py-0.5">
            <svg lucideStar class="h-3 w-3 text-yellow-400 fill-yellow-400"></svg>
            <span class="text-[11px] text-white font-semibold tabular-nums">{{ rating() | number:'1.1-1' }}</span>
          </div>
        }

        <!-- Top-left badge (episode number) -->
        @if (topLeftBadge()) {
          <div class="absolute top-1.5 left-1.5">
            <span class="badge badge-sm badge-neutral font-mono">{{ topLeftBadge() }}</span>
          </div>
        }

        <!-- Top-right: discover badge OR status icon -->
        @if (badge()) {
          <div class="absolute top-1.5 right-1.5">
            @switch (badge()) {
              @case ('library') {
                <div class="w-6 h-6 rounded-full bg-success flex items-center justify-center shadow">
                  <svg lucideCheck class="h-3.5 w-3.5 text-success-content"></svg>
                </div>
              }
              @case ('pending') {
                <div class="w-6 h-6 rounded-full bg-info flex items-center justify-center shadow">
                  <svg lucideClock class="h-3.5 w-3.5 text-info-content"></svg>
                </div>
              }
              @case ('declined') {
                <div class="w-6 h-6 rounded-full bg-error flex items-center justify-center shadow">
                  <svg lucideX class="h-3.5 w-3.5 text-error-content"></svg>
                </div>
              }
            }
          </div>
        } @else if (status() === 'watched') {
          <div class="absolute top-1.5 right-1.5">
            <svg lucideCircleCheck class="h-5 w-5 text-success drop-shadow"></svg>
          </div>
        } @else if (status() === 'missing') {
          <div class="absolute top-1.5 right-1.5">
            <svg lucideCircleX class="h-5 w-5 text-error/60 drop-shadow"></svg>
          </div>
        }

        <!-- Hover overlay -->
        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none group-hover:pointer-events-auto">
          @if (link()) {
            <a [routerLink]="link()" class="absolute inset-0 z-0" [attr.aria-label]="title()"></a>
          }
          @if (playable() || aspect() === 'landscape') {
            <div class="z-10 w-12 h-12 rounded-full bg-black/50 flex items-center justify-center text-white">
              <svg lucidePlay class="h-6 w-6" [strokeWidth]="2"></svg>
            </div>
          }
        </div>

        <!-- Progress bar -->
        @if (progressPercent() > 0) {
          <div class="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
            <div class="h-full bg-primary" [style.width.%]="progressPercent()"></div>
          </div>
        }
      </figure>

      <!-- Title below -->
      <div class="pt-1.5">
        @if (link()) {
          <a [routerLink]="link()" class="hover:underline">
            <h3 class="text-sm font-medium line-clamp-1 leading-snug">{{ title() }}</h3>
          </a>
        } @else {
          <h3 class="text-sm font-medium line-clamp-1 leading-snug">{{ title() }}</h3>
        }
        @if (subtitle()) {
          @if (subtitleLink()) {
            <a [routerLink]="subtitleLink()" class="hover:underline">
              <p class="text-xs text-base-content/50 line-clamp-1">{{ subtitle() }}</p>
            </a>
          } @else {
            <p class="text-xs text-base-content/50 line-clamp-1">{{ subtitle() }}</p>
          }
        }
      </div>

      <!-- Status bar (only when not watching) -->
      @if (barStatus() && progressPercent() <= 0) {
        <div class="h-1 w-full mt-0.5 rounded-full overflow-hidden">
          <div class="h-full transition-all" [ngClass]="barColorClass()" [style.width.%]="barPercent()"></div>
        </div>
      }

      <!-- Dismiss button -->
      @if (dismissable()) {
        <button
          type="button"
          class="absolute top-2 right-2 z-10 btn btn-circle btn-sm border-0 bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/65"
          (click)="dismissed.emit(); $event.stopPropagation()"
          aria-label="Remove"
        >
          <svg lucideX class="h-4 w-4" [strokeWidth]="2"></svg>
        </button>
      }
    </div>
  `,
})
export class MediaCardComponent {
  // Layout
  readonly aspect = input<MediaCardAspect>('portrait');

  // Image
  readonly imageUrl = input<string | null>(null);
  readonly imageBlurred = input(false);

  // Text
  readonly title = input('');
  readonly subtitle = input<string | undefined>(undefined);
  readonly rating = input(0);

  // Badges
  readonly topLeftBadge = input<string | undefined>(undefined);
  readonly badge = input<CardBadge>(null);
  readonly status = input<CardStatus>(null);

  // Navigation
  readonly link = input<string[] | null>(null);
  readonly subtitleLink = input<string[] | null>(null);
  readonly playable = input(false);

  // Progress
  readonly progressPercent = input(0);

  // Status bar
  readonly barStatus = input<BarStatus | null>(null);
  readonly barPercent = input(100);

  // State
  readonly dimmed = input(false);
  readonly dismissable = input(false);

  // Events
  readonly clicked = output<void>();
  readonly dismissed = output<void>();

  readonly barColorClass = computed(() => {
    const map: Record<BarStatus, string> = {
      'downloaded-monitored': 'bg-green-500',
      'downloaded-unmonitored': 'bg-green-800',
      'missing-monitored': 'bg-red-500',
      'missing-unmonitored': 'bg-amber-500',
      'queued': 'bg-purple-500',
      'unreleased': 'bg-blue-400',
    };
    return this.barStatus() ? map[this.barStatus()!] : '';
  });
}
