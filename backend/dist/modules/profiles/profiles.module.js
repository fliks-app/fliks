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
exports.ProfilesModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const quality_profile_entity_1 = require("./entities/quality-profile.entity");
const language_profile_entity_1 = require("./entities/language-profile.entity");
const custom_format_entity_1 = require("./entities/custom-format.entity");
const profiles_service_1 = require("./profiles.service");
const profiles_controller_1 = require("./profiles.controller");
const custom_formats_service_1 = require("./custom-formats.service");
const custom_formats_controller_1 = require("./custom-formats.controller");
const auth_module_1 = require("../auth/auth.module");
let ProfilesModule = class ProfilesModule {
    profiles;
    constructor(profiles) {
        this.profiles = profiles;
    }
    onModuleInit() {
        void this.profiles.ensureDefaultQualityProfiles();
    }
};
exports.ProfilesModule = ProfilesModule;
exports.ProfilesModule = ProfilesModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([quality_profile_entity_1.QualityProfile, language_profile_entity_1.LanguageProfile, custom_format_entity_1.CustomFormat]),
            auth_module_1.AuthModule,
        ],
        controllers: [profiles_controller_1.ProfilesController, custom_formats_controller_1.CustomFormatsController],
        providers: [profiles_service_1.ProfilesService, custom_formats_service_1.CustomFormatsService],
        exports: [profiles_service_1.ProfilesService, custom_formats_service_1.CustomFormatsService],
    }),
    __metadata("design:paramtypes", [profiles_service_1.ProfilesService])
], ProfilesModule);
//# sourceMappingURL=profiles.module.js.map