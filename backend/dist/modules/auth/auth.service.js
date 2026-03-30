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
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const bcrypt = __importStar(require("bcrypt"));
const crypto_1 = require("crypto");
const user_entity_1 = require("../users/entities/user.entity");
const enums_1 = require("../../common/enums");
let AuthService = class AuthService {
    userRepo;
    jwtService;
    config;
    constructor(userRepo, jwtService, config) {
        this.userRepo = userRepo;
        this.jwtService = jwtService;
        this.config = config;
    }
    getAccessCookieMaxAgeMs() {
        const raw = this.config.get('JWT_EXPIRATION', '7d');
        const m = /^(\d+)([dhms])$/i.exec(raw.trim());
        if (!m)
            return 7 * 24 * 60 * 60 * 1000;
        const n = parseInt(m[1], 10);
        const u = m[2].toLowerCase();
        const mult = u === 'd' ? 86400000 : u === 'h' ? 3600000 : u === 'm' ? 60000 : 1000;
        return n * mult;
    }
    async login(dto) {
        const serverType = dto.serverType ?? enums_1.MediaServerType.LOCAL;
        if (serverType === enums_1.MediaServerType.LOCAL) {
            return this.localLogin(dto.username, dto.password);
        }
        throw new common_1.UnauthorizedException(`Media server login for ${serverType} not yet implemented`);
    }
    async register(dto) {
        const existing = await this.userRepo.findOne({
            where: { username: dto.username },
        });
        if (existing) {
            throw new common_1.ConflictException('Username already taken');
        }
        const isFirstUser = (await this.userRepo.count()) === 0;
        const user = this.userRepo.create({
            username: dto.username,
            email: dto.email,
            passwordHash: await bcrypt.hash(dto.password, 12),
            role: isFirstUser ? enums_1.UserRole.ADMIN : enums_1.UserRole.USER,
            apiKey: this.generateApiKey(),
            mediaServerType: enums_1.MediaServerType.LOCAL,
        });
        const saved = await this.userRepo.save(user);
        const { passwordHash: _, ...safeUser } = saved;
        return safeUser;
    }
    async validateApiKey(apiKey) {
        return this.userRepo.findOne({ where: { apiKey, enabled: true } });
    }
    async localLogin(username, password) {
        const user = await this.userRepo.findOne({ where: { username } });
        if (!user?.passwordHash) {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        if (!user.enabled) {
            throw new common_1.UnauthorizedException('Account disabled');
        }
        user.lastLogin = new Date();
        await this.userRepo.save(user);
        const payload = { sub: user.id, username: user.username };
        const accessToken = this.jwtService.sign(payload);
        const { passwordHash, ...safeUser } = user;
        return { accessToken, user: safeUser };
    }
    generateApiKey() {
        return (0, crypto_1.randomBytes)(32).toString('hex');
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        jwt_1.JwtService,
        config_1.ConfigService])
], AuthService);
//# sourceMappingURL=auth.service.js.map