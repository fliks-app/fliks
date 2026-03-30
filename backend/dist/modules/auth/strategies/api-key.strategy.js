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
exports.ApiKeyStrategy = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const passport_http_header_strategy_1 = require("passport-http-header-strategy");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const user_entity_1 = require("../../users/entities/user.entity");
let ApiKeyStrategy = class ApiKeyStrategy extends (0, passport_1.PassportStrategy)(passport_http_header_strategy_1.Strategy, 'api-key') {
    userRepo;
    constructor(userRepo) {
        super({ header: 'X-Api-Key' });
        this.userRepo = userRepo;
    }
    async validate(apiKey) {
        if (!apiKey) {
            throw new common_1.UnauthorizedException();
        }
        const user = await this.userRepo.findOne({
            where: { apiKey, enabled: true },
        });
        if (!user) {
            throw new common_1.UnauthorizedException('Invalid API key');
        }
        return user;
    }
};
exports.ApiKeyStrategy = ApiKeyStrategy;
exports.ApiKeyStrategy = ApiKeyStrategy = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], ApiKeyStrategy);
//# sourceMappingURL=api-key.strategy.js.map