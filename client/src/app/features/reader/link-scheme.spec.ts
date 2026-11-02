import { allowedExternalLink } from './link-scheme';

describe('allowedExternalLink', () => {
  it.each([
    ['https://example.org/page', 'https://example.org/page'],
    ['http://example.org', 'http://example.org/'],
    ['mailto:someone@example.org', 'mailto:someone@example.org'],
    ['tel:+33123456789', 'tel:+33123456789'],
    ['  HTTPS://Example.org/x  ', 'https://example.org/x'],
  ])('lets %s through', (href, expected) => {
    expect(allowedExternalLink(href)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    ' \u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.org/uuid',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'ftp://example.org/file',
    'intent://scan#Intent;end',
  ])('refuses %j', (href) => {
    expect(allowedExternalLink(href)).toBeNull();
  });

  it.each(['OEBPS/ch2.xhtml', '../ch2.xhtml#note', '#note', 'OEBPS/javascript:alert(1)', '//example.org/x', ''])(
    'ignores the relative or unresolvable %j',
    (href) => {
      expect(allowedExternalLink(href)).toBeNull();
    },
  );
});
