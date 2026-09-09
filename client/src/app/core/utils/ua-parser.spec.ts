import { detectOs } from './ua-parser';

describe('detectOs', () => {
  it('names TV OSes that also claim Linux or Android', () => {
    expect(
      detectOs(
        'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager',
      ),
    ).toBe('webOS');
    expect(detectOs('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36')).toBe('Tizen');
    expect(detectOs('Mozilla/5.0 (Linux; Android 13; AndroidTV/1.0) AppleWebKit/537.36')).toBe(
      'Android TV',
    );
  });

  it('still resolves the desktop and mobile cases', () => {
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('Linux');
    expect(detectOs('Mozilla/5.0 (Linux; Android 13; Pixel 8) AppleWebKit/537.36')).toBe('Android');
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe(
      'macOS',
    );
    expect(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('Windows');
    expect(detectOs('irrelevant')).toBeNull();
  });
});
