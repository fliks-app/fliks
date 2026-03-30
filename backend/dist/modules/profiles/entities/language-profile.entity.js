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
exports.LanguageProfile = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
let LanguageProfile = class LanguageProfile extends base_entity_1.BaseEntity {
    name;
    cutoff;
    languages;
};
exports.LanguageProfile = LanguageProfile;
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], LanguageProfile.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], LanguageProfile.prototype, "cutoff", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb' }),
    __metadata("design:type", Array)
], LanguageProfile.prototype, "languages", void 0);
exports.LanguageProfile = LanguageProfile = __decorate([
    (0, typeorm_1.Entity)('language_profiles')
], LanguageProfile);
//# sourceMappingURL=language-profile.entity.js.map