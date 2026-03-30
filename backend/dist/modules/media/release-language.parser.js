"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseReleaseLanguage = parseReleaseLanguage;
const suitarr_languages_1 = require("../../common/constants/suitarr-languages");
function norm(s) {
    return s.replace(/[._\-]/g, ' ').toLowerCase();
}
function parseReleaseLanguage(title) {
    const t = norm(title);
    if (/\b(french|vff|vfi|vf\b|truefrench|vostfr|vost)\b/.test(t))
        return lang('fr');
    if (/\b(german|deutsch)\b/.test(t))
        return lang('de');
    if (/\b(spanish|espanol|esp\b|spa\b|latino)\b/.test(t))
        return lang('es');
    if (/\b(italian|italiano|ita\b)\b/.test(t))
        return lang('it');
    if (/\b(portuguese|portugu[eê]s|pt[\- ]br|ptbr|por\b)\b/.test(t))
        return lang('pt');
    if (/\b(japanese|japon[ae]s|jap\b|jpn\b)\b/.test(t))
        return lang('ja');
    if (/\b(korean|cor[eé]en|kor\b)\b/.test(t))
        return lang('ko');
    if (/\b(chinese|chinois|chi\b|chn\b|mandarin|cantonese)\b/.test(t))
        return lang('zh');
    if (/\b(russian|russe|rus\b)\b/.test(t))
        return lang('ru');
    if (/\b(arabic|arabe|ara\b)\b/.test(t))
        return lang('ar');
    if (/\b(dutch|nl\b|nlx|flemish)\b/.test(t))
        return lang('nl');
    if (/\b(polish|polonais|pol\b|pl\b)\b/.test(t))
        return lang('pl');
    if (/\b(turkish|turc|tur\b)\b/.test(t))
        return lang('tr');
    if (/\b(swedish|su[eè]dois|swe\b|sv\b)\b/.test(t))
        return lang('sv');
    if (/\b(danish|danois|dan\b|dk\b)\b/.test(t))
        return lang('da');
    if (/\b(norwegian|norv[eé]gien|nor\b|no\b)\b/.test(t))
        return lang('no');
    if (/\b(finnish|finlandais|fin\b)\b/.test(t))
        return lang('fi');
    if (/\bmulti\b/.test(t))
        return suitarr_languages_1.UNKNOWN_LANGUAGE;
    return suitarr_languages_1.ENGLISH_LANGUAGE;
}
function lang(isoCode) {
    return suitarr_languages_1.SUITARR_LANGUAGES.find((l) => l.isoCode === isoCode) ?? suitarr_languages_1.UNKNOWN_LANGUAGE;
}
//# sourceMappingURL=release-language.parser.js.map