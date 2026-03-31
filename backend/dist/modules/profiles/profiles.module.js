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
const quality_definition_entity_1 = require("./entities/quality-definition.entity");
const language_profile_entity_1 = require("./entities/language-profile.entity");
const custom_format_entity_1 = require("./entities/custom-format.entity");
const profiles_service_1 = require("./profiles.service");
const profiles_controller_1 = require("./profiles.controller");
const quality_definitions_service_1 = require("./quality-definitions.service");
const quality_definitions_controller_1 = require("./quality-definitions.controller");
const custom_formats_service_1 = require("./custom-formats.service");
const custom_formats_controller_1 = require("./custom-formats.controller");
const delay_profile_entity_1 = require("./entities/delay-profile.entity");
const delay_profiles_controller_1 = require("./delay-profiles.controller");
const tag_entity_1 = require("../tags/entities/tag.entity");
const auth_module_1 = require("../auth/auth.module");
let ProfilesModule = class ProfilesModule {
    profiles;
    qualityDefs;
    constructor(profiles, qualityDefs) {
        this.profiles = profiles;
        this.qualityDefs = qualityDefs;
    }
    onModuleInit() {
        void this.profiles.ensureDefaultQualityProfiles();
        void this.qualityDefs.ensureDefaults();
    }
};
exports.ProfilesModule = ProfilesModule;
exports.ProfilesModule = ProfilesModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([quality_profile_entity_1.QualityProfile, quality_definition_entity_1.QualityDefinition, language_profile_entity_1.LanguageProfile, custom_format_entity_1.CustomFormat, delay_profile_entity_1.DelayProfile, tag_entity_1.Tag]),
            auth_module_1.AuthModule,
        ],
        controllers: [profiles_controller_1.ProfilesController, custom_formats_controller_1.CustomFormatsController, delay_profiles_controller_1.DelayProfilesController, quality_definitions_controller_1.QualityDefinitionsController],
        providers: [profiles_service_1.ProfilesService, quality_definitions_service_1.QualityDefinitionsService, custom_formats_service_1.CustomFormatsService],
        exports: [profiles_service_1.ProfilesService, quality_definitions_service_1.QualityDefinitionsService, custom_formats_service_1.CustomFormatsService],
    }),
    __metadata("design:paramtypes", [profiles_service_1.ProfilesService,
        quality_definitions_service_1.QualityDefinitionsService])
], ProfilesModule);
//# sourceMappingURL=profiles.module.js.map