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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationConnection = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
let NotificationConnection = class NotificationConnection extends base_entity_1.BaseEntity {
    name;
    type;
    settings;
    events;
    enabled;
};
exports.NotificationConnection = NotificationConnection;
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], NotificationConnection.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], NotificationConnection.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', default: {} }),
    __metadata("design:type", Object)
], NotificationConnection.prototype, "settings", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', default: [] }),
    __metadata("design:type", Array)
], NotificationConnection.prototype, "events", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], NotificationConnection.prototype, "enabled", void 0);
exports.NotificationConnection = NotificationConnection = __decorate([
    (0, typeorm_1.Entity)('notification_connections')
], NotificationConnection);
//# sourceMappingURL=notification-connection.entity.js.map