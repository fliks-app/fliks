"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseReleaseQuality = parseReleaseQuality;
const suitarr_qualities_1 = require("../../common/constants/suitarr-qualities");
function norm(s) {
    return s.replace(/\./g, ' ').toLowerCase();
}
function parseReleaseQuality(title) {
    const t = norm(title);
    const isRemux = /\bremux\b/.test(t);
    const isBluray = /\b(bluray|blu-?ray|bdrip|brrip|bdr)\b/.test(t);
    const isWebDl = /\bweb-?dl\b/.test(t);
    const isWebRip = /\bweb-?rip\b/.test(t);
    const isHdtv = /\bhdtv\b/.test(t);
    const isDvd = /\b(dvd|dvdrip|dvd-?r)\b/.test(t);
    const isSdtv = /\bsdtv\b/.test(t);
    let resolution = 0;
    if (/\b(4320|8k)\b/.test(t))
        resolution = 4320;
    else if (/\b(2160|4k|uhd)\b/.test(t))
        resolution = 2160;
    else if (/\b1080(i|p)?\b/.test(t) || /\b1080\b/.test(t))
        resolution = 1080;
    else if (/\b720(i|p)?\b/.test(t) || /\b720\b/.test(t))
        resolution = 720;
    else if (/\b(576|480|360)p?\b/.test(t)) {
        const m = t.match(/\b(576|480|360)p?\b/);
        resolution = m ? parseInt(m[1], 10) : 480;
    }
    if (/\bcam\b/.test(t)) {
        const q = (0, suitarr_qualities_1.getSuitarrQualityById)(2);
        return { quality: q, label: q.name };
    }
    if (/\b(ts|telesync)\b/.test(t)) {
        const q = (0, suitarr_qualities_1.getSuitarrQualityById)(3);
        return { quality: q, label: q.name };
    }
    if (/\btc\b|telecine/.test(t)) {
        const q = (0, suitarr_qualities_1.getSuitarrQualityById)(4);
        return { quality: q, label: q.name };
    }
    let source = 'hdtv';
    if (isRemux)
        source = 'remux';
    else if (isBluray)
        source = 'bluray';
    else if (isWebDl || isWebRip)
        source = 'web';
    else if (isHdtv)
        source = 'hdtv';
    else if (isDvd)
        source = 'dvd';
    else if (isSdtv)
        source = 'sdtv';
    const candidates = suitarr_qualities_1.SUITARR_QUALITIES.filter((q) => q.resolution === resolution && q.source === source);
    if (candidates.length === 1) {
        const q = candidates[0];
        return { quality: q, label: q.name };
    }
    if (candidates.length > 1) {
        if (isWebDl) {
            const q = candidates.find((c) => c.name.includes('WEBDL')) ?? candidates[0];
            return { quality: q, label: q.name };
        }
        if (isWebRip) {
            const q = candidates.find((c) => c.name.includes('WEBRip')) ?? candidates[0];
            return { quality: q, label: q.name };
        }
        const q = candidates[candidates.length - 1];
        return { quality: q, label: q.name };
    }
    const fuzzy = suitarr_qualities_1.SUITARR_QUALITIES.filter((q) => {
        if (resolution > 0 && q.resolution !== resolution)
            return false;
        if (resolution === 0 && q.resolution > 480)
            return false;
        return true;
    });
    const fallback = fuzzy.find((q) => q.source === source) ??
        fuzzy[fuzzy.length - 1] ??
        suitarr_qualities_1.SUITARR_QUALITIES[0];
    return { quality: fallback, label: fallback.name };
}
//# sourceMappingURL=release-quality.parser.js.map