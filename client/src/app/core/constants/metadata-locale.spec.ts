import { metadataRegionOptions } from './metadata-locale';

describe('metadataRegionOptions', () => {
  it('localizes region names to the given UI language', () => {
    const en = metadataRegionOptions('en');
    const fr = metadataRegionOptions('fr');
    expect(en.find((o) => o.code === 'US')?.label).toBe('United States');
    expect(fr.find((o) => o.code === 'US')?.label).toBe('États-Unis');
    expect(en.length).toBe(fr.length);
  });

  it('falls back to the raw code on an unusable locale tag', () => {
    const opts = metadataRegionOptions('not-a-locale');
    expect(opts.find((o) => o.code === 'JP')?.label).toBeTruthy();
  });
});
