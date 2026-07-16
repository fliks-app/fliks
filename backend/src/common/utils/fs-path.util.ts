/** Invisible bidi/format control code points that Windows Explorer's "Copy as
 *  path" prepends (0x202A LEFT-TO-RIGHT EMBEDDING) — plus other zero-width
 *  marks, directional isolates and the BOM. Left in place they make an
 *  absolute path parse as relative, so a scan/library path silently resolves
 *  under the process cwd. */
const FS_CONTROL_CODES = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // ZWSP, ZWNJ, ZWJ, LRM, RLM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE, RLE, PDF, LRO, RLO
  0x2066, 0x2067, 0x2068, 0x2069, // LRI, RLI, FSI, PDI
  0xfeff, // BOM / ZWNBSP
]);

/** Strip invisible control characters and surrounding whitespace from a
 *  user-supplied filesystem path. */
export function sanitizeFsPath(input: string): string {
  let out = '';
  for (const ch of input) {
    if (!FS_CONTROL_CODES.has(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.trim();
}
