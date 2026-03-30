"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDefaultMovieQualityProfileDto = buildDefaultMovieQualityProfileDto;
const suitarr_qualities_1 = require("../../common/constants/suitarr-qualities");
function buildDefaultMovieQualityProfileDto() {
    const allowedIds = new Set([
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    ]);
    const items = suitarr_qualities_1.SUITARR_QUALITIES.map((q, index) => ({
        qualityId: q.id,
        qualityName: q.name,
        resolution: q.resolution,
        source: q.source,
        allowed: allowedIds.has(q.id),
        sortOrder: index,
    }));
    return {
        name: suitarr_qualities_1.DEFAULT_MOVIE_QUALITY_PROFILE_NAME,
        cutoff: 16,
        upgradeAllowed: true,
        items,
    };
}
//# sourceMappingURL=default-movie-quality-profile.js.map