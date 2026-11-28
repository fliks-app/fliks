import { TranslateService } from '@ngx-translate/core';
import { failureText } from './karaoke-failure';

const translate = {
  instant: (key: string, p: Record<string, unknown>) =>
    key === 'karaoke.failure.lyrics_not_found_in_vocals' ? `only ${p['matched']} % (min ${p['min']} %)` : key === 'karaoke.failure.failed' ? 'failed' : key,
} as unknown as TranslateService;

describe('failureText', () => {
  it('translates the code with its params', () => {
    expect(failureText(translate, { code: 'lyrics_not_found_in_vocals', matched: 26, min: 30 })).toBe('only 26 % (min 30 %)');
  });

  it('appends the server message when there is one', () => {
    expect(failureText(translate, { code: 'failed', message: 'boom' })).toBe('failed boom');
  });

  it('reads a code it does not know as a plain failure', () => {
    expect(failureText(translate, { code: 'newer_code' as 'failed' })).toBe('failed');
  });
});
