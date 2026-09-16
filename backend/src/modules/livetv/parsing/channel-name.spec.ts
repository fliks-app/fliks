import { normalizeChannelName, nameSimilarity } from './channel-name';

describe('normalizeChannelName', () => {
  it('folds quality noise, case, accents and punctuation', () => {
    expect(normalizeChannelName('FR: Canal+ Décalé FHD')).toBe(
      normalizeChannelName('canal+ decale'),
    );
  });

  it('drops bracketed and parenthesised annotations', () => {
    expect(normalizeChannelName('One [Backup] (1080p)')).toBe('one');
  });

  it('keeps the plus sign that distinguishes a channel', () => {
    expect(normalizeChannelName('Canal+')).toBe('canal+');
    expect(normalizeChannelName('Canal')).toBe('canal');
  });
});

describe('nameSimilarity', () => {
  it('scores a shared token set high and a disjoint one at zero', () => {
    expect(nameSimilarity('Sport One HD', 'Sport One')).toBe(1);
    expect(nameSimilarity('Sport One', 'Movies Two')).toBe(0);
  });

  it('is empty-safe', () => {
    expect(nameSimilarity('', 'One')).toBe(0);
  });
});
