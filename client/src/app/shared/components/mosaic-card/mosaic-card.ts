import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { LucideFolder } from '@lucide/angular';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { ImgFadeInDirective } from '../../directives/img-fade-in.directive';

@Component({
  selector: 'app-mosaic-card',
  imports: [LucideFolder, ResolveUrlPipe, ImgFadeInDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      data-no-focus-ring
      class="group flex flex-col items-stretch gap-2 text-left focus:outline-none min-w-0 w-full cursor-pointer"
      (click)="clicked.emit()"
    >
      <div class="mosaic-art relative aspect-square rounded-xl overflow-hidden bg-base-300 shadow-md group-hover:shadow-xl transition-shadow">
        @if (posters().length >= 4) {
          <div class="grid grid-cols-2 grid-rows-2 w-full h-full">
            @for (p of posters().slice(0, 4); track p) {
              <img appImgFadeIn [src]="p | resolveUrl:'thumb'" alt="" loading="lazy" class="w-full h-full object-cover" />
            }
          </div>
        } @else if (posters().length > 0) {
          <img appImgFadeIn [src]="posters()[0] | resolveUrl:'medium'" alt="" loading="lazy" class="w-full h-full object-cover" />
        } @else {
          <div class="w-full h-full flex items-center justify-center text-base-content/30">
            <svg lucideFolder class="w-12 h-12" [strokeWidth]="1.5"></svg>
          </div>
        }
        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
      </div>
      <div class="text-sm md:text-base min-w-0 w-full">
        <div class="font-medium truncate hover:underline">{{ label() }}</div>
        <div class="text-xs md:text-sm text-base-content/50">{{ subtitle() }}</div>
      </div>
    </button>
  `,
})
export class MosaicCardComponent {
  readonly posters = input.required<string[]>();
  readonly label = input.required<string>();
  /** Pre-formatted subtitle line under the label (e.g. "5 éléments"). */
  readonly subtitle = input.required<string>();
  readonly clicked = output<void>();
}
