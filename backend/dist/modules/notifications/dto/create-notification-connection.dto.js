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
exports.CreateNotificationConnectionDto = void 0;
const class_validator_1 = require("class-validator");
const VALID_TYPES = ['discord', 'slack', 'webhook', 'gotify', 'ntfy'];
const VALID_EVENTS = [
    'request.created',
    'request.approved',
    'request.declined',
    'grab.started',
    'download.complete',
    'health.issue',
];
class CreateNotificationConnectionDto {
    name;
    type;
    settings;
    events;
    enabled;
}
exports.CreateNotificationConnectionDto = CreateNotificationConnectionDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateNotificationConnectionDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsIn)(VALID_TYPES),
    __metadata("design:type", String)
], CreateNotificationConnectionDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreateNotificationConnectionDto.prototype, "settings", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsIn)(VALID_EVENTS, { each: true }),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Array)
], CreateNotificationConnectionDto.prototype, "events", void 0);
__decorate([
    (0, class_validator_1.IsBoolean)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Boolean)
], CreateNotificationConnectionDto.prototype, "enabled", void 0);
//# sourceMappingURL=create-notification-connection.dto.js.map