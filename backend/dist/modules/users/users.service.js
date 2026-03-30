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
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsersService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const bcrypt = __importStar(require("bcrypt"));
const crypto_1 = require("crypto");
const user_entity_1 = require("./entities/user.entity");
const enums_1 = require("../../common/enums");
let UsersService = class UsersService {
    userRepo;
    constructor(userRepo) {
        this.userRepo = userRepo;
    }
    findAll() {
        return this.userRepo.find({ order: { username: 'ASC' } });
    }
    async findOne(id) {
        const user = await this.userRepo.findOne({ where: { id } });
        if (!user)
            throw new common_1.NotFoundException(`User #${id} not found`);
        return user;
    }
    async update(targetId, dto, requester) {
        const target = await this.findOne(targetId);
        const isSelf = requester.id === targetId;
        const isAdmin = requester.role === enums_1.UserRole.ADMIN;
        if (!isSelf && !isAdmin)
            throw new common_1.ForbiddenException();
        if (dto.username !== undefined) {
            const dup = await this.userRepo.findOne({ where: { username: dto.username } });
            if (dup && dup.id !== targetId) {
                throw new common_1.ConflictException('Username already taken');
            }
            target.username = dto.username;
        }
        if (dto.email !== undefined)
            target.email = dto.email;
        if (dto.password !== undefined) {
            target.passwordHash = await bcrypt.hash(dto.password, 12);
        }
        if (isAdmin) {
            if (dto.role !== undefined)
                target.role = dto.role;
            if (dto.enabled !== undefined)
                target.enabled = dto.enabled;
        }
        else if (dto.role !== undefined || dto.enabled !== undefined) {
            throw new common_1.ForbiddenException('Only admins can change role or enabled status');
        }
        if (dto.movieQuotaLimit !== undefined)
            target.movieQuotaLimit = dto.movieQuotaLimit;
        if (dto.seriesQuotaLimit !== undefined)
            target.seriesQuotaLimit = dto.seriesQuotaLimit;
        if (dto.quotaPeriodDays !== undefined)
            target.quotaPeriodDays = dto.quotaPeriodDays;
        return this.userRepo.save(target);
    }
    async remove(id) {
        const user = await this.findOne(id);
        await this.userRepo.remove(user);
    }
    async regenerateApiKey(id, requester) {
        const target = await this.findOne(id);
        if (requester.id !== id && requester.role !== enums_1.UserRole.ADMIN) {
            throw new common_1.ForbiddenException();
        }
        target.apiKey = (0, crypto_1.randomBytes)(32).toString('hex');
        return this.userRepo.save(target);
    }
};
exports.UsersService = UsersService;
exports.UsersService = UsersService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], UsersService);
//# sourceMappingURL=users.service.js.map