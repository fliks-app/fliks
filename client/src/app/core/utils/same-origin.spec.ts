import { sameOriginPath } from './same-origin';

describe('sameOriginPath', () => {
  it('keeps paths of this origin', () => {
    expect(sameOriginPath('/requests?a=1#x')).toBe('/requests?a=1#x');
    expect(sameOriginPath(`${location.origin}/party/3`)).toBe('/party/3');
  });

  it('rejects other origins', () => {
    for (const u of ['//evil.test/x', '/\\evil.test', 'https://evil.test/', 'javascript:alert(1)', '', undefined]) {
      expect(sameOriginPath(u)).toBeNull();
    }
  });
});
