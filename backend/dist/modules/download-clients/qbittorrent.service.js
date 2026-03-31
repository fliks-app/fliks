"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var QbittorrentService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.QbittorrentService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
let QbittorrentService = QbittorrentService_1 = class QbittorrentService {
    log = new common_1.Logger(QbittorrentService_1.name);
    buildBaseUrl(s) {
        let host = String(s.host || '').replace(/\/$/, '');
        if (!host)
            return null;
        const protocol = s.useSsl ? 'https' : 'http';
        host = host.replace(/^https?:\/\//i, '');
        const portFromHost = host.match(/:(\d+)$/);
        if (portFromHost)
            host = host.replace(/:\d+$/, '');
        const port = s.port || (portFromHost ? Number(portFromHost[1]) : undefined);
        return `${protocol}://${host}${port ? `:${port}` : ''}`;
    }
    async testConnection(settings) {
        const s = settings;
        const base = this.buildBaseUrl(s);
        if (!base) {
            return { ok: false, message: 'Host is required' };
        }
        try {
            const http = axios_1.default.create({
                timeout: 10_000,
                headers: { 'User-Agent': 'Suitarr/1.0' },
            });
            const formAuth = new URLSearchParams({
                username: s.username ?? '',
                password: s.password ?? '',
            });
            const res = await http.post(`${base}/api/v2/auth/login`, formAuth.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                validateStatus: () => true,
            });
            if (res.data === 'Fails.' || !res.headers['set-cookie']?.length) {
                return {
                    ok: false,
                    message: 'Authentication failed — check credentials',
                };
            }
            return { ok: true, message: 'Successfully connected to qBittorrent' };
        }
        catch (e) {
            return {
                ok: false,
                message: `Could not reach qBittorrent: ${e.message}`,
            };
        }
    }
    async getTorrents(client) {
        const s = client.settings;
        const base = this.buildBaseUrl(s);
        if (!base)
            return [];
        const http = axios_1.default.create({
            timeout: 15_000,
            headers: { 'User-Agent': 'Suitarr/1.0' },
        });
        const formAuth = new URLSearchParams({
            username: s.username ?? '',
            password: s.password ?? '',
        });
        let cookieHeader = '';
        try {
            const loginRes = await http.post(`${base}/api/v2/auth/login`, formAuth.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                validateStatus: () => true,
            });
            const cookies = loginRes.headers['set-cookie'];
            if (!cookies?.length || loginRes.data === 'Fails.') {
                this.log.warn(`getTorrents: auth failed for client "${client.name}" at ${base}`);
                return [];
            }
            cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
        }
        catch (e) {
            this.log.warn(`getTorrents: cannot reach client "${client.name}" at ${base}: ${e.message}`);
            return [];
        }
        try {
            const params = {};
            if (s.category?.trim())
                params.category = s.category.trim();
            const res = await http.get(`${base}/api/v2/torrents/info`, {
                headers: { Cookie: cookieHeader },
                params,
                validateStatus: () => true,
            });
            if (!Array.isArray(res.data)) {
                this.log.warn(`getTorrents: unexpected response from "${client.name}": ${typeof res.data}`);
                return [];
            }
            return res.data;
        }
        catch (e) {
            this.log.warn(`getTorrents: error fetching torrents from "${client.name}": ${e.message}`);
            return [];
        }
    }
    async deleteTorrent(client, hash, deleteFiles = false) {
        const s = client.settings;
        const base = this.buildBaseUrl(s);
        if (!base) {
            throw new common_1.BadRequestException('qBittorrent client has no host configured');
        }
        const http = axios_1.default.create({
            timeout: 15_000,
            headers: { 'User-Agent': 'Suitarr/1.0' },
        });
        const formAuth = new URLSearchParams({
            username: s.username ?? '',
            password: s.password ?? '',
        });
        const loginRes = await http.post(`${base}/api/v2/auth/login`, formAuth.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            validateStatus: () => true,
        });
        const cookies = loginRes.headers['set-cookie'];
        if (!cookies?.length || loginRes.data === 'Fails.') {
            throw new common_1.BadRequestException('qBittorrent authentication failed');
        }
        const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
        const params = new URLSearchParams({
            hashes: hash,
            deleteFiles: String(deleteFiles),
        });
        const res = await http.post(`${base}/api/v2/torrents/delete`, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookieHeader,
            },
            validateStatus: () => true,
        });
        if (res.status !== 200) {
            throw new common_1.BadRequestException(`qBittorrent refused deletion (HTTP ${res.status})`);
        }
    }
    supports(client) {
        if (!client.enabled)
            return false;
        return (client.implementation || '').toLowerCase().includes('qbittorrent');
    }
    sanitizeUrl(url) {
        return url.replace(/&amp;/g, '&');
    }
    async addTorrentUrl(client, torrentUrl, mediaType) {
        torrentUrl = this.sanitizeUrl(torrentUrl);
        const s = client.settings;
        const base = this.buildBaseUrl(s);
        if (!base) {
            throw new common_1.BadRequestException('qBittorrent client has no host configured');
        }
        let category = String(s.category ?? '').trim();
        if (mediaType === 'movie' && s.movieCategory)
            category = String(s.movieCategory).trim();
        if (mediaType === 'series' && s.seriesCategory)
            category = String(s.seriesCategory).trim();
        const http = axios_1.default.create({
            timeout: 60_000,
            headers: { 'User-Agent': 'Suitarr/1.0' },
        });
        const formAuth = new URLSearchParams({
            username: String(s.username ?? ''),
            password: String(s.password ?? ''),
        });
        let cookieHeader = '';
        try {
            const loginRes = await http.post(`${base}/api/v2/auth/login`, formAuth.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                maxRedirects: 0,
                validateStatus: () => true,
            });
            const cookies = loginRes.headers['set-cookie'];
            if (!cookies?.length || loginRes.data === 'Fails.') {
                throw new common_1.BadRequestException('qBittorrent authentication failed');
            }
            cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
        }
        catch (e) {
            if (e instanceof common_1.BadRequestException)
                throw e;
            this.log.warn(`qBittorrent login error: ${e.message}`);
            throw new common_1.BadRequestException('Could not reach qBittorrent API');
        }
        let addRes;
        if (torrentUrl.startsWith('magnet:')) {
            const formAdd = new URLSearchParams({ urls: torrentUrl });
            if (category)
                formAdd.set('category', category);
            addRes = await http.post(`${base}/api/v2/torrents/add`, formAdd.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: cookieHeader,
                },
                validateStatus: () => true,
            });
        }
        else {
            this.log.log(`Downloading .torrent from: ${torrentUrl}`);
            let torrentBuffer;
            try {
                const dlRes = await http.get(torrentUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30_000,
                    validateStatus: () => true,
                });
                if (dlRes.status !== 200) {
                    this.log.error(`Indexer returned HTTP ${dlRes.status} for torrent download — URL: ${torrentUrl}`);
                    throw new common_1.BadRequestException(`Indexer returned HTTP ${dlRes.status} for torrent download`);
                }
                torrentBuffer = Buffer.from(dlRes.data);
                this.log.log(`Downloaded .torrent OK (${torrentBuffer.length} bytes)`);
            }
            catch (e) {
                if (e instanceof common_1.BadRequestException)
                    throw e;
                this.log.error(`Failed to download torrent file — URL: ${torrentUrl} — Error: ${e.message}`);
                throw new common_1.BadRequestException(`Could not fetch torrent from indexer: ${e.message}`);
            }
            const fd = new form_data_1.default();
            fd.append('torrents', torrentBuffer, {
                filename: 'download.torrent',
                contentType: 'application/x-bittorrent',
            });
            if (category)
                fd.append('category', category);
            addRes = await http.post(`${base}/api/v2/torrents/add`, fd, {
                headers: { ...fd.getHeaders(), Cookie: cookieHeader },
                validateStatus: () => true,
            });
        }
        if (addRes.status !== 200) {
            throw new common_1.BadRequestException(`qBittorrent refused the torrent (HTTP ${addRes.status})`);
        }
    }
};
exports.QbittorrentService = QbittorrentService;
exports.QbittorrentService = QbittorrentService = QbittorrentService_1 = __decorate([
    (0, common_1.Injectable)()
], QbittorrentService);
//# sourceMappingURL=qbittorrent.service.js.map