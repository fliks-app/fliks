import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';

/** Renders markdown to HTML (e.g. release notes) for `[innerHTML]` (Angular sanitizes it); links get target=_blank so clicks don't navigate the webview away. */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '';
    const html = marked.parse(value, { async: false, gfm: true }) as string;
    return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }
}
