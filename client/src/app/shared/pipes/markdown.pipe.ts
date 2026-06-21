import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';

/** Renders a markdown string to HTML (e.g. GitHub release notes). Bind the
 *  result with `[innerHTML]` — Angular sanitizes it. Links get target=_blank
 *  so a click doesn't navigate the app/webview away. */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '';
    const html = marked.parse(value, { async: false, gfm: true }) as string;
    return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
  }
}
