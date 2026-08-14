import { PluginCountsCacheService } from './plugin-counts-cache.service';

describe('PluginCountsCacheService', () => {
  it('adds up a key two plugins push instead of letting the second overwrite the first', () => {
    const cache = new PluginCountsCacheService();
    cache.set('fliks.a', 'queueActive', 3);
    cache.set('fliks.b', 'queueActive', 4);
    expect(cache.get('queueActive')).toBe(7);
  });

  it('keeps each plugin to its own slot, so one cannot read or clear another key', () => {
    const cache = new PluginCountsCacheService();
    cache.set('fliks.a', 'queueActive', 3);
    cache.set('fliks.b', 'other', 9);
    expect(cache.get('queueActive')).toBe(3);
    expect(cache.get('other')).toBe(9);
  });

  it('stops counting a plugin that is no longer running', () => {
    const cache = new PluginCountsCacheService();
    cache.set('fliks.a', 'queueActive', 3);
    cache.set('fliks.b', 'queueActive', 4);
    cache.forget('fliks.a');
    expect(cache.get('queueActive')).toBe(4);
    expect(cache.has('queueActive')).toBe(true);
    cache.forget('fliks.b');
    expect(cache.has('queueActive')).toBe(false);
  });

  it('tells an explicit zero apart from never having been pushed', () => {
    const cache = new PluginCountsCacheService();
    expect(cache.has('queueActive')).toBe(false);
    cache.set('fliks.a', 'queueActive', 0);
    expect(cache.has('queueActive')).toBe(true);
    expect(cache.get('queueActive')).toBe(0);
  });
});
