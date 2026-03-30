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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsController = void 0;
const common_1 = require("@nestjs/common");
const class_validator_1 = require("class-validator");
const settings_service_1 = require("./settings.service");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
class SetSettingDto {
    value;
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], SetSettingDto.prototype, "value", void 0);
class SetBulkDto {
    data;
}
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], SetBulkDto.prototype, "data", void 0);
let SettingsController = class SettingsController {
    service;
    constructor(service) {
        this.service = service;
    }
    getAll() {
        return this.service.getAll();
    }
    getOne(key) {
        return this.service.get(key).then((value) => ({ key, value }));
    }
    setOne(key, dto) {
        return this.service.set(key, dto.value ?? null);
    }
    setBulk(dto) {
        return this.service.setBulk(dto.data).then(() => ({ ok: true }));
    }
};
exports.SettingsController = SettingsController;
__decorate([
    (0, common_1.Get)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "getAll", null);
__decorate([
    (0, common_1.Get)(':key'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, 'Settings')),
    __param(0, (0, common_1.Param)('key')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "getOne", null);
__decorate([
    (0, common_1.Put)(':key'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, 'Settings')),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, SetSettingDto]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "setOne", null);
__decorate([
    (0, common_1.Put)(),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Manage, 'Settings')),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [SetBulkDto]),
    __metadata("design:returntype", void 0)
], SettingsController.prototype, "setBulk", null);
exports.SettingsController = SettingsController = __decorate([
    (0, common_1.Controller)('settings'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __metadata("design:paramtypes", [settings_service_1.SettingsService])
], SettingsController);
//# sourceMappingURL=settings.controller.js.map