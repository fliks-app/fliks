import { createHash } from 'crypto';

/** A minimal, valid SVG — no script, no event handler, parses as `<svg>` rooted XML. */
export function svgLogo(): Buffer {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>', 'utf8');
}

/** PNG magic bytes followed by a few arbitrary bytes — enough for the magic-byte sniff, not a decodable image. */
export function pngLogo(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 0])]);
}

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
