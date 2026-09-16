import { detectXtreamFromStreamUrl, xtreamPlaylistUrl } from './xtream.client';

describe('detectXtreamFromStreamUrl', () => {
  it('reads the credentials a panel puts in every stream URL', () => {
    expect(
      detectXtreamFromStreamUrl('http://panel.example:8080/live/joe/s3cret/1234.ts'),
    ).toEqual({ baseUrl: 'http://panel.example:8080', username: 'joe', password: 's3cret' });
  });

  it('accepts the shape without a leading content segment', () => {
    expect(detectXtreamFromStreamUrl('https://p.example/joe/s3cret/9.m3u8')).toEqual({
      baseUrl: 'https://p.example',
      username: 'joe',
      password: 's3cret',
    });
  });

  it('ignores a URL that is not a panel stream', () => {
    expect(detectXtreamFromStreamUrl('https://cdn.example/hls/live/2031003/x/index.m3u8'))
      .toBeNull();
    expect(detectXtreamFromStreamUrl('http://h/')).toBeNull();
    expect(detectXtreamFromStreamUrl('not a url')).toBeNull();
  });

  it('rebuilds the playlist link that refreshes itself', () => {
    const creds = { baseUrl: 'http://panel.example:8080', username: 'jo e', password: 'p/w' };
    expect(xtreamPlaylistUrl(creds)).toBe(
      'http://panel.example:8080/get.php?username=jo%20e&password=p%2Fw&type=m3u_plus&output=ts',
    );
  });
});
