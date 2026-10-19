import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ServerConfigService } from './server-config.service';

describe('ServerConfigService — updateKnownServer', () => {
  it('renames and moves an entry, absorbing one already on the new URL', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const config = TestBed.inject(ServerConfigService);
    await config.addOrTouchKnownServer('http://new.lan:3000');
    await config.addOrTouchKnownServer('http://old.lan:3000', { username: 'alice' });

    await config.updateKnownServer('http://old.lan:3000', { name: ' Home ', url: 'http://new.lan:3000/' });

    expect(config.knownServers()).toEqual([
      expect.objectContaining({ url: 'http://new.lan:3000', name: 'Home', lastUsername: 'alice' }),
    ]);
  });
});
