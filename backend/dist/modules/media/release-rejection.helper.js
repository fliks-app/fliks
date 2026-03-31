"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAllowedQualityIds = buildAllowedQualityIds;
exports.buildIndexerMinSeeders = buildIndexerMinSeeders;
exports.computeRejections = computeRejections;
function buildAllowedQualityIds(items) {
    const set = new Set();
    if (!items?.length)
        return set;
    const allowedGroupIds = new Set();
    for (const item of items) {
        if (item.allowed) {
            set.add(item.quality.id);
            if (item.groupId != null)
                allowedGroupIds.add(item.groupId);
        }
    }
    if (allowedGroupIds.size > 0) {
        for (const item of items) {
            if (item.groupId != null && allowedGroupIds.has(item.groupId)) {
                set.add(item.quality.id);
            }
        }
    }
    return set;
}
function buildIndexerMinSeeders(indexers) {
    return new Map(indexers.map((ix) => [ix.id, Math.max(0, Number(ix.settings?.['minSeeders']) || 0)]));
}
function computeRejections(opts) {
    const out = [];
    if (!opts.allowed.has(opts.qualityId)) {
        out.push({ code: 'QUALITY_NOT_ALLOWED' });
    }
    if (opts.allowedLangs.size > 0 && !opts.allowedLangs.has(opts.languageId)) {
        out.push({ code: 'LANGUAGE_NOT_ALLOWED' });
    }
    if (opts.isBlocklisted) {
        out.push({ code: 'BLOCKLISTED' });
    }
    const sizeMb = opts.sizeBytes > 0 ? opts.sizeBytes / (1024 * 1024) : 0;
    const limits = opts.sizeByQuality.get(opts.qualityId);
    if (limits && sizeMb > 0) {
        if (limits.min > 0 && sizeMb < limits.min) {
            out.push({ code: 'SIZE_TOO_LOW', params: { actual: Math.round(sizeMb), min: limits.min } });
        }
        if (limits.max > 0 && sizeMb > limits.max) {
            out.push({ code: 'SIZE_TOO_HIGH', params: { actual: Math.round(sizeMb), max: limits.max } });
        }
        if (limits.preferred > 0 &&
            out.every((r) => r.code !== 'SIZE_TOO_LOW' && r.code !== 'SIZE_TOO_HIGH')) {
            const deviation = Math.abs(sizeMb - limits.preferred) / limits.preferred;
            if (deviation > 0.3) {
                out.push({
                    code: 'SIZE_NOT_PREFERRED',
                    params: { actual: Math.round(sizeMb), preferred: limits.preferred },
                });
            }
        }
    }
    const minSeed = opts.indexerMinSeeders.get(opts.indexerId) ?? 0;
    if (minSeed > 0 && opts.seeders < minSeed) {
        out.push({ code: 'MIN_SEEDERS', params: { actual: opts.seeders, min: minSeed } });
    }
    return out;
}
//# sourceMappingURL=release-rejection.helper.js.map