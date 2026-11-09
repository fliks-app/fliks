import { TranslateService } from '@ngx-translate/core';
import { capabilityLabels } from './plugin-capability';

describe('capabilityLabels', () => {
  const translate = {
    instant: (key: string, p: { value: string }) => `${key.split('.').pop()}(${p.value})`,
  } as unknown as TranslateService;

  it('labels each permission once and shows a provider by its kind', () => {
    expect(
      capabilityLabels(translate, ['ui:settings.page', 'ui:settings.page', 'provider:tmdb:movie', 'other:x']),
    ).toEqual(['ui(settings.page)', 'provider(movie)', 'other:x']);
  });
});
