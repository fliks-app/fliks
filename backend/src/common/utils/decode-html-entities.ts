/**
 * Decode the Latin-1 HTML4 named entities + numeric character refs
 * that surface in release titles emitted by Cardigann-wrapped
 * release feeds (`Berl&iacute;n` → `Berlín`) and in `.torrent` `name`
 * fields whose creator HTML-escaped diacritics before generating
 * the metainfo. Restricted to the Western-European subset that
 * actually shows up in real-world titles — adding hundreds of
 * astral-plane entities would pull no extra coverage and bloat the
 * lookup. Plain XML (`&amp;` etc.) is included so the helper is a
 * drop-in replacement for the basic XML decoder.
 */
const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', apos: "'", quot: '"', nbsp: ' ',
  iexcl: '¡', cent: '¢', pound: '£', yen: '¥', sect: '§',
  copy: '©', reg: '®', deg: '°', plusmn: '±', sup2: '²', sup3: '³',
  micro: 'µ', para: '¶', middot: '·', sup1: '¹', frac14: '¼', frac12: '½',
  frac34: '¾', iquest: '¿', Agrave: 'À', Aacute: 'Á', Acirc: 'Â',
  Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì',
  Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
  Yacute: 'Ý', THORN: 'Þ', szlig: 'ß', agrave: 'à', aacute: 'á',
  acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', eth: 'ð',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ',
  ouml: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û',
  uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ', OElig: 'Œ',
  oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', ldquo: '“',
  rdquo: '”', lsquo: '‘', rsquo: '’', bdquo: '„', hellip: '…',
  ndash: '–', mdash: '—', trade: '™', euro: '€',
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(?:#(x?)([0-9a-fA-F]+)|([a-zA-Z]+));/g, (raw, hex, num, name) => {
    if (num) {
      const code = parseInt(num, hex === 'x' ? 16 : 10);
      if (isFinite(code) && code > 0) {
        try { return String.fromCodePoint(code); } catch { /* invalid code point */ }
      }
      return raw;
    }
    return HTML_NAMED_ENTITIES[name as string] ?? raw;
  });
}
