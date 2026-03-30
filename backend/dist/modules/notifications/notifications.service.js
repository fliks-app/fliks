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
var NotificationsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const axios_1 = __importDefault(require("axios"));
const notification_connection_entity_1 = require("./entities/notification-connection.entity");
let NotificationsService = NotificationsService_1 = class NotificationsService {
    repo;
    log = new common_1.Logger(NotificationsService_1.name);
    constructor(repo) {
        this.repo = repo;
    }
    create(dto) {
        const row = this.repo.create({
            name: dto.name,
            type: dto.type,
            settings: dto.settings ?? {},
            events: (dto.events ?? []),
            enabled: dto.enabled ?? true,
        });
        return this.repo.save(row);
    }
    findAll() {
        return this.repo.find({ order: { name: 'ASC' } });
    }
    async findOne(id) {
        const conn = await this.repo.findOne({ where: { id } });
        if (!conn)
            throw new common_1.NotFoundException(`Notification connection #${id} not found`);
        return conn;
    }
    async update(id, dto) {
        const conn = await this.findOne(id);
        if (dto.name !== undefined)
            conn.name = dto.name;
        if (dto.type !== undefined)
            conn.type = dto.type;
        if (dto.settings !== undefined)
            conn.settings = dto.settings;
        if (dto.events !== undefined)
            conn.events = dto.events;
        if (dto.enabled !== undefined)
            conn.enabled = dto.enabled;
        return this.repo.save(conn);
    }
    async remove(id) {
        const conn = await this.findOne(id);
        await this.repo.remove(conn);
    }
    async dispatch(event, payload) {
        const connections = await this.repo.find({ where: { enabled: true } });
        const relevant = connections.filter((c) => c.events.includes(event));
        await Promise.allSettled(relevant.map((c) => this.send(c, event, payload)));
    }
    async testConnection(id) {
        const conn = await this.findOne(id);
        try {
            await this.send(conn, 'health.issue', { test: true, message: 'Test notification from Suitarr' });
            return { ok: true, message: 'Test notification sent' };
        }
        catch (e) {
            return { ok: false, message: e.message };
        }
    }
    async send(conn, event, payload) {
        const s = conn.settings;
        try {
            switch (conn.type) {
                case 'discord': {
                    const webhookUrl = String(s.webhookUrl ?? '');
                    if (!webhookUrl)
                        throw new Error('webhookUrl not configured');
                    await axios_1.default.post(webhookUrl, {
                        username: String(s.username ?? 'Suitarr'),
                        content: this.formatMessage(event, payload),
                    });
                    break;
                }
                case 'slack': {
                    const webhookUrl = String(s.webhookUrl ?? '');
                    if (!webhookUrl)
                        throw new Error('webhookUrl not configured');
                    await axios_1.default.post(webhookUrl, { text: this.formatMessage(event, payload) });
                    break;
                }
                case 'webhook': {
                    const url = String(s.url ?? '');
                    if (!url)
                        throw new Error('url not configured');
                    await axios_1.default.post(url, { event, ...payload }, {
                        headers: s.token ? { Authorization: `Bearer ${s.token}` } : {},
                    });
                    break;
                }
                case 'gotify': {
                    const url = String(s.url ?? '').replace(/\/$/, '');
                    const token = String(s.token ?? '');
                    if (!url || !token)
                        throw new Error('url and token required');
                    await axios_1.default.post(`${url}/message?token=${token}`, {
                        title: `Suitarr — ${event}`,
                        message: this.formatMessage(event, payload),
                        priority: 5,
                    });
                    break;
                }
                case 'ntfy': {
                    const url = String(s.url ?? '').replace(/\/$/, '');
                    const topic = String(s.topic ?? 'suitarr');
                    await axios_1.default.post(`${url}/${topic}`, this.formatMessage(event, payload), {
                        headers: { Title: `Suitarr — ${event}` },
                    });
                    break;
                }
                default:
                    this.log.warn(`Unknown notification type: ${conn.type}`);
            }
        }
        catch (e) {
            this.log.warn(`Failed to send notification via ${conn.name}: ${e.message}`);
            throw e;
        }
    }
    formatMessage(event, payload) {
        const title = payload.title ?? '';
        switch (event) {
            case 'request.created': return `New request: ${title}`;
            case 'request.approved': return `Request approved: ${title}`;
            case 'request.declined': return `Request declined: ${title}`;
            case 'grab.started': return `Grabbing: ${title}`;
            case 'download.complete': return `Download complete: ${title}`;
            case 'health.issue': return String(payload.message ?? 'Health issue detected');
            default: return `${event}: ${JSON.stringify(payload)}`;
        }
    }
};
exports.NotificationsService = NotificationsService;
exports.NotificationsService = NotificationsService = NotificationsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(notification_connection_entity_1.NotificationConnection)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], NotificationsService);
//# sourceMappingURL=notifications.service.js.map