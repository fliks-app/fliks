"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogBufferService = void 0;
const common_1 = require("@nestjs/common");
let LogBufferService = class LogBufferService extends common_1.ConsoleLogger {
    buffer = [];
    maxSize = 2000;
    log(message, context) {
        super.log(message, context);
        this.push('log', String(message), context ?? '');
    }
    warn(message, context) {
        super.warn(message, context);
        this.push('warn', String(message), context ?? '');
    }
    error(message, trace, context) {
        super.error(message, trace, context);
        this.push('error', String(message) + (trace ? `\n${trace}` : ''), context ?? '');
    }
    debug(message, context) {
        super.debug(message, context);
        this.push('debug', String(message), context ?? '');
    }
    push(level, message, context) {
        this.buffer.push({ timestamp: new Date().toISOString(), level, context, message });
        if (this.buffer.length > this.maxSize) {
            this.buffer = this.buffer.slice(-this.maxSize);
        }
    }
    getEntries(opts) {
        let entries = [...this.buffer];
        if (opts?.level)
            entries = entries.filter(e => e.level === opts.level);
        if (opts?.q) {
            const q = opts.q.toLowerCase();
            entries = entries.filter(e => e.message.toLowerCase().includes(q) || e.context.toLowerCase().includes(q));
        }
        entries.reverse();
        if (opts?.limit && opts.limit > 0)
            entries = entries.slice(0, opts.limit);
        return entries;
    }
};
exports.LogBufferService = LogBufferService;
exports.LogBufferService = LogBufferService = __decorate([
    (0, common_1.Injectable)()
], LogBufferService);
//# sourceMappingURL=log-buffer.service.js.map