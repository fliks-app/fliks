import { Pipe, PipeTransform } from '@angular/core';
import type { MediaType } from '../enums/media-type.enum';
import { mediaDetailLink } from '../media-kinds';

@Pipe({ name: 'mediaLink' })
export class MediaLinkPipe implements PipeTransform {
  transform(type: MediaType, id: number | string): string[] {
    return mediaDetailLink(type, id);
  }
}
