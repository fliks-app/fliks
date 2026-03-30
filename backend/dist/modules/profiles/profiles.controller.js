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
exports.ProfilesController = void 0;
const common_1 = require("@nestjs/common");
const profiles_service_1 = require("./profiles.service");
const create_quality_profile_dto_1 = require("./dto/create-quality-profile.dto");
const create_language_profile_dto_1 = require("./dto/create-language-profile.dto");
const jwt_or_api_key_guard_1 = require("../auth/guards/jwt-or-api-key.guard");
const policies_guard_1 = require("../auth/casl/policies.guard");
const check_policies_decorator_1 = require("../auth/casl/check-policies.decorator");
const actions_enum_1 = require("../auth/casl/actions.enum");
const quality_profile_entity_1 = require("./entities/quality-profile.entity");
const language_profile_entity_1 = require("./entities/language-profile.entity");
const suitarr_languages_1 = require("../../common/constants/suitarr-languages");
let ProfilesController = class ProfilesController {
    profilesService;
    constructor(profilesService) {
        this.profilesService = profilesService;
    }
    createQuality(dto) {
        return this.profilesService.createQualityProfile(dto);
    }
    findAllQuality() {
        return this.profilesService.findAllQualityProfiles();
    }
    findOneQuality(id) {
        return this.profilesService.findOneQualityProfile(id);
    }
    updateQuality(id, dto) {
        return this.profilesService.updateQualityProfile(id, dto);
    }
    removeQuality(id) {
        return this.profilesService.removeQualityProfile(id);
    }
    languageDefinitions() {
        return suitarr_languages_1.SUITARR_LANGUAGES;
    }
    createLanguage(dto) {
        return this.profilesService.createLanguageProfile(dto);
    }
    findAllLanguage() {
        return this.profilesService.findAllLanguageProfiles();
    }
    findOneLanguage(id) {
        return this.profilesService.findOneLanguageProfile(id);
    }
    updateLanguage(id, dto) {
        return this.profilesService.updateLanguageProfile(id, dto);
    }
    removeLanguage(id) {
        return this.profilesService.removeLanguageProfile(id);
    }
};
exports.ProfilesController = ProfilesController;
__decorate([
    (0, common_1.Post)('quality'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, quality_profile_entity_1.QualityProfile)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_quality_profile_dto_1.CreateQualityProfileDto]),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "createQuality", null);
__decorate([
    (0, common_1.Get)('quality'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, quality_profile_entity_1.QualityProfile)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "findAllQuality", null);
__decorate([
    (0, common_1.Get)('quality/:id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, quality_profile_entity_1.QualityProfile)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "findOneQuality", null);
__decorate([
    (0, common_1.Put)('quality/:id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, quality_profile_entity_1.QualityProfile)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, create_quality_profile_dto_1.CreateQualityProfileDto]),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "updateQuality", null);
__decorate([
    (0, common_1.Delete)('quality/:id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, quality_profile_entity_1.QualityProfile)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "removeQuality", null);
__decorate([
    (0, common_1.Get)('language-definitions'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, language_profile_entity_1.LanguageProfile)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "languageDefinitions", null);
__decorate([
    (0, common_1.Post)('language'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Create, language_profile_entity_1.LanguageProfile)),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_language_profile_dto_1.CreateLanguageProfileDto]),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "createLanguage", null);
__decorate([
    (0, common_1.Get)('language'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, language_profile_entity_1.LanguageProfile)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "findAllLanguage", null);
__decorate([
    (0, common_1.Get)('language/:id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Read, language_profile_entity_1.LanguageProfile)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "findOneLanguage", null);
__decorate([
    (0, common_1.Put)('language/:id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Update, language_profile_entity_1.LanguageProfile)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, create_language_profile_dto_1.CreateLanguageProfileDto]),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "updateLanguage", null);
__decorate([
    (0, common_1.Delete)('language/:id'),
    (0, check_policies_decorator_1.CheckPolicies)((ability) => ability.can(actions_enum_1.Action.Delete, language_profile_entity_1.LanguageProfile)),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], ProfilesController.prototype, "removeLanguage", null);
exports.ProfilesController = ProfilesController = __decorate([
    (0, common_1.Controller)('profiles'),
    (0, common_1.UseGuards)(jwt_or_api_key_guard_1.JwtOrApiKeyGuard, policies_guard_1.PoliciesGuard),
    __metadata("design:paramtypes", [profiles_service_1.ProfilesService])
], ProfilesController);
//# sourceMappingURL=profiles.controller.js.map