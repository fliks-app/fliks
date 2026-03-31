"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var TorznabService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TorznabService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const axios_1 = __importDefault(require("axios"));
const indexer_stat_entity_1 = require("./entities/indexer-stat.entity");
function decodeXmlEntities(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"');
}
function extractInnerXml(block, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = block.match(re);
    if (!m)
        return null;
    return decodeXmlEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
}
function torznabAttr(block, name) {
    const re = new RegExp(`<torznab:attr[^>]+name="${name}"[^>]+value="([^"]*)"`, 'i');
    const m = block.match(re);
    return m ? m[1].trim() : null;
}
function ensureApiKey(url, apiKey) {
    if (!apiKey || url.startsWith('magnet:'))
        return url;
    try {
        const clean = decodeXmlEntities(url);
        const u = new URL(clean);
        u.searchParams.set('apikey', apiKey);
        return u.toString();
    }
    catch {
        return url;
    }
}
function parseTorznabItems(xml, indexer) {
    const settings = indexer.settings;
    const apiKey = String(settings.apiKey || '');
    const out = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
        const block = m[1];
        const title = extractInnerXml(block, 'title');
        const link = extractInnerXml(block, 'link');
        const magnetAttr = block.match(/name="magneturl"\s+value="([^"]*)"/i) ||
            block.match(/name='magneturl'\s+value='([^']*)'/i);
        const magnet = magnetAttr?.[1]
            ? decodeXmlEntities(magnetAttr[1].trim())
            : undefined;
        const enc = block.match(/<enclosure[^>]*\surl="([^"]+)"/i);
        const encUrl = enc?.[1] ? decodeXmlEntities(enc[1].trim()) : undefined;
        const url = magnet ||
            (link?.startsWith('magnet:') ? link : null) ||
            encUrl ||
            (link && !link.startsWith('http://localhost') ? link : null);
        if (!title || !url)
            continue;
        const encLen = enc?.[0]?.match(/\blength="(\d+)"/i)?.[1];
        const sizeStr = encLen ?? torznabAttr(block, 'size') ?? extractInnerXml(block, 'size');
        const size = sizeStr ? parseInt(sizeStr, 10) || 0 : 0;
        const seeders = parseInt(torznabAttr(block, 'seeders') ?? '0', 10) || 0;
        const leechers = parseInt(torznabAttr(block, 'leechers') ?? torznabAttr(block, 'peers') ?? '0', 10) || 0;
        const dvfStr = torznabAttr(block, 'downloadvolumefactor');
        const downloadVolumeFactor = dvfStr !== null ? parseFloat(dvfStr) : 1;
        const freeleech = downloadVolumeFactor === 0;
        const pubDateRaw = extractInnerXml(block, 'pubDate');
        let publishDate = null;
        if (pubDateRaw) {
            const d = new Date(pubDateRaw);
            if (!isNaN(d.getTime()))
                publishDate = d.toISOString();
        }
        out.push({
            title,
            downloadUrl: ensureApiKey(url, apiKey),
            indexerId: indexer.id,
            indexerName: indexer.name,
            size,
            seeders,
            leechers,
            publishDate,
            freeleech,
            downloadVolumeFactor,
        });
    }
    return out;
}
let TorznabService = TorznabService_1 = class TorznabService {
    statRepo;
    log = new common_1.Logger(TorznabService_1.name);
    constructor(statRepo) {
        this.statRepo = statRepo;
    }
    async testConnection(baseUrl, apiKey) {
        const base = String(baseUrl || '').replace(/\/$/, '');
        if (!base) {
            return { ok: false, message: 'baseUrl vide' };
        }
        const url = `${base}?t=caps&apikey=${encodeURIComponent(apiKey || '')}`;
        try {
            const res = await axios_1.default.get(url, {
                timeout: 30_000,
                responseType: 'text',
                headers: { 'User-Agent': 'Suitarr/1.0' },
                validateStatus: () => true,
            });
            const body = typeof res.data === 'string' ? res.data : String(res.data);
            if (res.status >= 400) {
                return { ok: false, message: `HTTP ${res.status}` };
            }
            if (/<error\s+code=/i.test(body)) {
                const m = body.match(/description="([^"]*)"/i);
                return { ok: false, message: m?.[1]?.trim() || 'Erreur Torznab' };
            }
            if (!/<caps/i.test(body)) {
                return {
                    ok: false,
                    message: 'Réponse inattendue (pas de document Torznab « caps »)',
                };
            }
            return { ok: true, message: 'Torznab : capacités lues, connexion OK' };
        }
        catch (e) {
            return { ok: false, message: e.message };
        }
    }
    async rssSearch(indexer) {
        if (!indexer.enabled || !indexer.enableRss)
            return [];
        const settings = indexer.settings;
        const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
        const apiKey = String(settings.apiKey || '');
        if (!baseUrl)
            return [];
        const url = `${baseUrl}?t=search&q=&cat=2000&apikey=${encodeURIComponent(apiKey)}`;
        const start = Date.now();
        try {
            const res = await axios_1.default.get(url, {
                timeout: 60_000,
                responseType: 'text',
                headers: { 'User-Agent': 'Suitarr/1.0' },
                validateStatus: (s) => s >= 200 && s < 400,
            });
            const body = typeof res.data === 'string' ? res.data : String(res.data);
            const results = parseTorznabItems(body, indexer);
            void this.statRepo.save(this.statRepo.create({
                indexerId: indexer.id,
                queryType: 'rss',
                responseTimeMs: Date.now() - start,
                resultCount: results.length,
                errorMessage: null,
            }));
            return results;
        }
        catch (e) {
            void this.statRepo.save(this.statRepo.create({
                indexerId: indexer.id,
                queryType: 'rss',
                responseTimeMs: Date.now() - start,
                resultCount: 0,
                errorMessage: e.message,
            }));
            this.log.warn(`RSS sync failed for "${indexer.name}": ${e.message}`);
            return [];
        }
    }
    async searchSeasonPack(indexer, showTitle, season) {
        if (!indexer.enabled || !indexer.enableSearch)
            return [];
        const impl = (indexer.implementation || '').toLowerCase();
        if (!impl.includes('torznab'))
            return [];
        const settings = indexer.settings;
        const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
        const apiKey = String(settings.apiKey || '');
        if (!baseUrl)
            return [];
        const url = `${baseUrl}?t=tvsearch&q=${encodeURIComponent(showTitle)}&season=${season}&cat=5000&apikey=${encodeURIComponent(apiKey)}`;
        const start = Date.now();
        try {
            const res = await axios_1.default.get(url, {
                timeout: 90_000,
                responseType: 'text',
                headers: { 'User-Agent': 'Suitarr/1.0' },
                validateStatus: (s) => s >= 200 && s < 400,
            });
            const body = typeof res.data === 'string' ? res.data : String(res.data);
            const results = parseTorznabItems(body, indexer);
            void this.statRepo.save(this.statRepo.create({
                indexerId: indexer.id,
                queryType: 'season',
                responseTimeMs: Date.now() - start,
                resultCount: results.length,
                errorMessage: null,
            }));
            return results;
        }
        catch (e) {
            void this.statRepo.save(this.statRepo.create({
                indexerId: indexer.id,
                queryType: 'season',
                responseTimeMs: Date.now() - start,
                resultCount: 0,
                errorMessage: e.message,
            }));
            this.log.warn(`Torznab season pack search failed for "${indexer.name}": ${e.message}`);
            return [];
        }
    }
    async searchSeries(indexer, showTitle, season, episode) {
        if (!indexer.enabled || !indexer.enableSearch)
            return [];
        const impl = (indexer.implementation || '').toLowerCase();
        if (!impl.includes('torznab'))
            return [];
        const settings = indexer.settings;
        const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
        const apiKey = String(settings.apiKey || '');
        if (!baseUrl)
            return [];
        const url = `${baseUrl}?t=tvsearch&q=${encodeURIComponent(showTitle)}&season=${season}&ep=${episode}&cat=5000&apikey=${encodeURIComponent(apiKey)}`;
        const start = Date.now();
        try {
            const res = await axios_1.default.get(url, {
                timeout: 90_000,
                responseType: 'text',
                headers: { 'User-Agent': 'Suitarr/1.0' },
                validateStatus: (s) => s >= 200 && s < 400,
            });
            const body = typeof res.data === 'string' ? res.data : String(res.data);
            const results = parseTorznabItems(body, indexer);
            void this.statRepo.save(this.statRepo.create({
                indexerId: indexer.id,
                queryType: 'tvsearch',
                responseTimeMs: Date.now() - start,
                resultCount: results.length,
                errorMessage: null,
            }));
            return results;
        }
        catch (e) {
            void this.statRepo.save(this.statRepo.create({
                indexerId: indexer.id,
                queryType: 'tvsearch',
                responseTimeMs: Date.now() - start,
                resultCount: 0,
                errorMessage: e.message,
            }));
            this.log.warn(`Torznab tvsearch failed for "${indexer.name}": ${e.message}`);
            return [];
        }
    }
    async searchMovie(indexer, query) {
        if (!indexer.enabled || !indexer.enableSearch)
            return [];
        const impl = (indexer.implementation || '').toLowerCase();
        if (!impl.includes('torznab'))
            return [];
        const settings = indexer.settings;
        const baseUrl = String(settings.baseUrl || '').replace(/\/$/, '');
        const apiKey = String(settings.apiKey || '');
        if (!baseUrl) {
            this.log.warn(`Indexer "${indexer.name}" has no baseUrl`);
            return [];
        }
        const url = `${baseUrl}?t=search&q=${encodeURIComponent(query)}&cat=2000&apikey=${encodeURIComponent(apiKey)}`;
        const start = Date.now();
        try {
            const res = await axios_1.default.get(url, {
                timeout: 90_000,
                responseType: 'text',
                headers: { 'User-Agent': 'Suitarr/1.0' },
                validateStatus: (s) => s >= 200 && s < 400,
            });
            const body = typeof res.data === 'string' ? res.data : String(res.data);
            const results = parseTorznabItems(body, indexer);
            void this.statRepo.save(this.statRepo.create({
                indexerId: indexer.id,
                queryType: 'search',
                responseTimeMs: Date.now() - start,
                resultCount: results.length,
                errorMessage: null,
            }));
            return results;
        }
        catch (e) {
            void this.statRepo.save(this.statRepo.create({
                indexerId: indexer.id,
                queryType: 'search',
                responseTimeMs: Date.now() - start,
                resultCount: 0,
                errorMessage: e.message,
            }));
            this.log.warn(`Torznab search failed for "${indexer.name}": ${e.message}`);
            return [];
        }
    }
};
exports.TorznabService = TorznabService;
exports.TorznabService = TorznabService = TorznabService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(indexer_stat_entity_1.IndexerStat)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TorznabService);
//# sourceMappingURL=torznab.service.js.map