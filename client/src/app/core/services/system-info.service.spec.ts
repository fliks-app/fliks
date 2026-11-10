import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

const getInfo = vi.hoisted(() => vi.fn());
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/device', () => ({ Device: { getInfo } }));

import { SystemInfoService } from './system-info.service';

async function deviceName(info: Record<string, string>): Promise<string> {
  getInfo.mockResolvedValue({ operatingSystem: 'ios', osVersion: '18.1', ...info });
  const service = TestBed.inject(SystemInfoService);
  await service.ready();
  return service.deviceName();
}

describe('SystemInfoService', () => {
  it('treats the product class iOS reports as a name as no name', async () => {
    expect(await deviceName({ name: 'iPhone', model: 'iPhone11,2' })).toBe('');
  });

  it('keeps a name its owner chose', async () => {
    expect(await deviceName({ name: 'Clement iPhone', model: 'iPhone11,2' })).toBe('Clement iPhone');
  });
});
