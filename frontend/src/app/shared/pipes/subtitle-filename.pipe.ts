import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'subtitleFilename' })
export class SubtitleFilenamePipe implements PipeTransform {
  transform(filePath: string | null | undefined): string {
    if (!filePath) return '';
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || filePath;
  }
}
