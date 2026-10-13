import { describe, expect, it } from 'vitest';
import { parseDeviceLabel } from './format-device-label';

describe('parseDeviceLabel', () => {
  it('names the Apple TV app from its native system name, whatever its user agent says', () => {
    expect(parseDeviceLabel('Fliks/4.4 CFNetwork/1568 Darwin/24.0', 'tvOS 26.4')).toEqual({
      key: 'system.device_apple_tv',
      params: { os: 'tvOS 26.4' },
    });
    expect(parseDeviceLabel(null, 'tvOS 26.4')?.key).toBe('system.device_apple_tv');
    expect(parseDeviceLabel('AppleTV11,1/26.4', null)?.key).toBe('system.device_apple_tv');
  });

  it('keeps the other native clients', () => {
    expect(parseDeviceLabel('Mozilla/5.0 (Linux; Android 14; LE2113 Build/X; wv) AppleWebKit/537.36', null)?.key).toContain(
      'mobile_app',
    );
    expect(parseDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', 'iOS 18.5')?.key).toContain(
      'mobile_app',
    );
    expect(parseDeviceLabel('Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36', null)?.key).toBe('system.device_samsung_tv');
    expect(parseDeviceLabel('Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36', null)?.key).toBe('system.device_lg_tv');
    expect(
      parseDeviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130 Electron/33 Safari/537.36', 'Windows 11')?.key,
    ).toBe('system.device_desktop_app_on_os');
  });
});
