"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.NamingService = void 0;
const common_1 = require("@nestjs/common");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.ts', '.m2ts', '.wmv', '.flv']);
let NamingService = class NamingService {
    applyMovieFormat(format, data) {
        let name = format;
        name = name.replace(/\{Movie Title\}/g, data.title ?? '');
        name = name.replace(/\{Original Title\}/g, data.originalTitle || data.title || '');
        name = name.replace(/\{Release Year\}/g, data.year ? String(data.year) : '');
        name = name.replace(/\{Quality Full\}/g, data.quality ?? '');
        name = name.replace(/\{Quality Title\}/g, data.quality ?? '');
        name = name.replace(/\{Release Group\}/g, data.releaseGroup ?? '');
        name = name.replace(/\{TMDB Id\}/g, data.tmdbId ? String(data.tmdbId) : '');
        name = name.replace(/\{MediaInfo AudioCodec\}/g, '');
        name = name.replace(/\{MediaInfo VideoCodec\}/g, '');
        return this.sanitize(name);
    }
    applySeriesFormat(format, data) {
        let name = format;
        name = name.replace(/\{Series Title\}/g, data.seriesTitle ?? '');
        name = name.replace(/\{season:00\}/g, String(data.season).padStart(2, '0'));
        name = name.replace(/\{episode:00\}/g, String(data.episode).padStart(2, '0'));
        name = name.replace(/\{Episode Title\}/g, data.episodeTitle ?? '');
        name = name.replace(/\{Quality Full\}/g, data.quality ?? '');
        name = name.replace(/\{Quality Title\}/g, data.quality ?? '');
        name = name.replace(/\{Release Group\}/g, data.releaseGroup ?? '');
        name = name.replace(/\{Air Date\}/g, data.airDate ?? '');
        name = name.replace(/\{MediaInfo AudioCodec\}/g, '');
        name = name.replace(/\{MediaInfo VideoCodec\}/g, '');
        return this.sanitize(name);
    }
    applySeriesFolderFormat(format, data) {
        let name = format;
        name = name.replace(/\{Series Title\}/g, data.seriesTitle ?? '');
        name = name.replace(/\{Release Year\}/g, data.year ? String(data.year) : '');
        name = name.replace(/\{TMDB Id\}/g, data.tmdbId ? String(data.tmdbId) : '');
        return this.sanitize(name);
    }
    applySeasonFolderFormat(format, data) {
        let name = format;
        name = name.replace(/\{season:00\}/g, String(data.season).padStart(2, '0'));
        name = name.replace(/\{season\}/g, String(data.season));
        return this.sanitize(name);
    }
    parseQuality(sourceTitle) {
        const upper = sourceTitle.toUpperCase();
        if (upper.includes('2160P') || upper.includes('4K') || upper.includes('UHD'))
            return '2160p';
        if (upper.includes('1080P'))
            return '1080p';
        if (upper.includes('720P'))
            return '720p';
        if (upper.includes('480P'))
            return '480p';
        if (upper.includes('BLURAY') || upper.includes('BLU-RAY'))
            return 'Bluray';
        if (upper.includes('BDRIP'))
            return 'BDRip';
        if (upper.includes('BRRIP'))
            return 'BRRip';
        if (upper.includes('WEBRIP'))
            return 'WEBRip';
        if (upper.includes('WEB-DL') || upper.includes('WEBDL'))
            return 'WEB-DL';
        if (upper.includes('WEB'))
            return 'WEB';
        if (upper.includes('HDTV'))
            return 'HDTV';
        if (upper.includes('DVDRIP'))
            return 'DVDRip';
        if (upper.includes('DVDSCR'))
            return 'DVDSCR';
        if (upper.includes('HDCAM') || upper.includes('HD-CAM'))
            return 'HDCAM';
        if (upper.includes('CAM') || upper.includes('CAMRIP'))
            return 'CAM';
        if (upper.includes('HDTS') || upper.includes('TELESYNC'))
            return 'Telesync';
        if (upper.includes('REMUX'))
            return 'Remux';
        return '';
    }
    extractReleaseGroup(sourceTitle) {
        const m = sourceTitle.match(/-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?$/i);
        return m?.[1] ?? '';
    }
    parseEpisodeNumbers(sourceTitle) {
        const m = sourceTitle.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
        if (!m)
            return null;
        return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    }
    findLargestVideoFile(dirPath) {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            let best = null;
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const sub = this.findLargestVideoFile(path.join(dirPath, entry.name));
                    if (sub && (!best || sub.size > best.size))
                        best = sub;
                }
                else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
                    const fullPath = path.join(dirPath, entry.name);
                    const stat = fs.statSync(fullPath);
                    if (!best || stat.size > best.size) {
                        best = { filePath: fullPath, size: stat.size };
                    }
                }
            }
            return best;
        }
        catch {
            return null;
        }
    }
    sanitize(name) {
        return name
            .replace(/\{[^}]*\}/g, '')
            .replace(/undefined/g, '')
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
            .replace(/\s{2,}/g, ' ')
            .replace(/\(\s*\)/g, '')
            .replace(/\[\s*\]/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }
};
exports.NamingService = NamingService;
exports.NamingService = NamingService = __decorate([
    (0, common_1.Injectable)()
], NamingService);
//# sourceMappingURL=naming.service.js.map