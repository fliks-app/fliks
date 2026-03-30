"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthModule = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const passport_1 = require("@nestjs/passport");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const auth_service_1 = require("./auth.service");
const auth_controller_1 = require("./auth.controller");
const jwt_strategy_1 = require("./strategies/jwt.strategy");
const api_key_strategy_1 = require("./strategies/api-key.strategy");
const casl_ability_factory_1 = require("./casl/casl-ability.factory");
const policies_guard_1 = require("./casl/policies.guard");
const user_entity_1 = require("../users/entities/user.entity");
let AuthModule = class AuthModule {
};
exports.AuthModule = AuthModule;
exports.AuthModule = AuthModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([user_entity_1.User]),
            passport_1.PassportModule,
            jwt_1.JwtModule.registerAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    secret: config.getOrThrow('JWT_SECRET'),
                    signOptions: {
                        expiresIn: config.get('JWT_EXPIRATION', '7d'),
                    },
                }),
            }),
        ],
        controllers: [auth_controller_1.AuthController],
        providers: [
            auth_service_1.AuthService,
            jwt_strategy_1.JwtStrategy,
            api_key_strategy_1.ApiKeyStrategy,
            casl_ability_factory_1.CaslAbilityFactory,
            policies_guard_1.PoliciesGuard,
        ],
        exports: [auth_service_1.AuthService, casl_ability_factory_1.CaslAbilityFactory, policies_guard_1.PoliciesGuard, jwt_1.JwtModule],
    })
], AuthModule);
//# sourceMappingURL=auth.module.js.map