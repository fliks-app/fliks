import { MediaType } from '../enums/media-type.enum';
import { MediaLinkPipe } from './media-link.pipe';

describe('MediaLinkPipe', () => {
  const pipe = new MediaLinkPipe();

  it('links each kind to its detail page', () => {
    expect(pipe.transform('movie', 3)).toEqual(['/movies', '3']);
    expect(pipe.transform('series', '4')).toEqual(['/series', '4']);
  });

  it('refuses a kind the registry does not describe', () => {
    expect(() => pipe.transform('' as MediaType, 1)).toThrow();
    expect(() => pipe.transform(null as unknown as MediaType, 1)).toThrow();
  });
});
