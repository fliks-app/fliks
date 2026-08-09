import { isInternalAddress } from './internal-address';

/**
 * A plugin-supplied webhook URL is the only outbound reach a `data` plugin has,
 * so this table is the tier's security boundary. Both spellings of the
 * IPv4-mapped form are here on purpose: a check that recognises only the
 * compressed one is bypassed by writing the other.
 */
describe('isInternalAddress', () => {
  const cases: [string, boolean][] = [
  ['127.0.0.1', true], ['10.1.2.3', true], ['169.254.169.254', true],
  ['172.16.0.1', true], ['172.31.255.255', true], ['192.168.1.1', true],
  ['0.0.0.0', true], ['::1', true], ['::', true], ['fe80::1', true],
  ['fc00::1', true], ['fd12:3456::1', true], ['::ffff:127.0.0.1', true],
  ['8.8.8.8', false], ['1.1.1.1', false], ['2606:4700::1111', false],
  ['172.32.0.1', false], ['172.15.0.1', false], ['192.169.1.1', false],
  // adversarial forms
  ['::ffff:10.0.0.1', true],
  ['::FFFF:169.254.169.254', true],
  ['0:0:0:0:0:ffff:127.0.0.1', true],
  ['64:ff9b::127.0.0.1', true],
  ['fe80:0000:0000:0000:0000:0000:0000:0001', true],
  ['100.64.0.1', true],
  ['198.18.0.1', true],
  ['192.0.0.1', true],
  ['255.255.255.255', true],
  ['224.0.0.1', true],
];

  it.each(cases)('%s -> blocked=%s', (ip, blocked) => {
    expect(isInternalAddress(ip)).toBe(blocked);
  });

  it('refuses anything that is not a literal IP', () => {
    for (const bogus of ['', 'example.com', '127.0.0.1.evil.com', '0x7f000001']) {
      expect(isInternalAddress(bogus)).toBe(true);
    }
  });
});
