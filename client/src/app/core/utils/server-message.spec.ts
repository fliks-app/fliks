import type { TranslateService } from '@ngx-translate/core';
import { serverMessage, translatedServerMessage } from './server-message';

/** Knows two keys; anything else comes back unchanged, like ngx-translate does. */
const translate = {
  instant: (key: string) =>
    key === 'errors.plugin_timeout' ? 'The plugin took too long' : key === 'fallback.key' ? 'Fallback' : key,
} as TranslateService;

describe('translatedServerMessage', () => {
  it('translates a key the catalogue knows', () => {
    expect(translatedServerMessage('errors.plugin_timeout', translate)).toBe('The plugin took too long');
  });

  it('keeps a plain sentence the backend wrote', () => {
    expect(translatedServerMessage('Username already taken', translate)).toBe('Username already taken');
  });

  it('joins a validation array', () => {
    expect(translatedServerMessage(['too short', 'not a url'], translate)).toBe('too short, not a url');
  });

  it('reports nothing for an absent or non-string message', () => {
    expect(translatedServerMessage(undefined, translate)).toBeNull();
    expect(translatedServerMessage('', translate)).toBeNull();
    expect(translatedServerMessage({ nested: true }, translate)).toBeNull();
  });
});

describe('serverMessage', () => {
  it('prefers the translated server message', () => {
    const err = { error: { message: 'errors.plugin_timeout' } };
    expect(serverMessage(err, translate, 'fallback.key')).toBe('The plugin took too long');
  });

  it('falls back when the body carries no message', () => {
    expect(serverMessage({ error: {} }, translate, 'fallback.key')).toBe('Fallback');
    expect(serverMessage(null, translate, 'fallback.key')).toBe('Fallback');
  });
});
