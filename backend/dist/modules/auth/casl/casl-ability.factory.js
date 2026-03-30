"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CaslAbilityFactory = void 0;
const ability_1 = require("@casl/ability");
const common_1 = require("@nestjs/common");
const user_entity_1 = require("../../users/entities/user.entity");
const media_entity_1 = require("../../media/entities/media.entity");
const request_entity_1 = require("../../requests/entities/request.entity");
const quality_profile_entity_1 = require("../../profiles/entities/quality-profile.entity");
const language_profile_entity_1 = require("../../profiles/entities/language-profile.entity");
const tag_entity_1 = require("../../tags/entities/tag.entity");
const actions_enum_1 = require("./actions.enum");
const enums_1 = require("../../../common/enums");
let CaslAbilityFactory = class CaslAbilityFactory {
    createForUser(user) {
        const { can, build } = new ability_1.AbilityBuilder(ability_1.createMongoAbility);
        switch (user.role) {
            case enums_1.UserRole.ADMIN:
                can(actions_enum_1.Action.Manage, 'all');
                can(actions_enum_1.Action.Grab, media_entity_1.Media);
                break;
            case enums_1.UserRole.USER:
                can(actions_enum_1.Action.Read, media_entity_1.Media);
                can(actions_enum_1.Action.Create, media_entity_1.Media);
                can(actions_enum_1.Action.Grab, media_entity_1.Media);
                can(actions_enum_1.Action.Read, tag_entity_1.Tag);
                can(actions_enum_1.Action.Read, quality_profile_entity_1.QualityProfile);
                can(actions_enum_1.Action.Read, language_profile_entity_1.LanguageProfile);
                can(actions_enum_1.Action.Create, request_entity_1.SuitarrRequest);
                can(actions_enum_1.Action.Read, request_entity_1.SuitarrRequest, { userId: user.id });
                can(actions_enum_1.Action.Delete, request_entity_1.SuitarrRequest, {
                    userId: user.id,
                    status: 'pending',
                });
                can(actions_enum_1.Action.Update, request_entity_1.SuitarrRequest, {
                    userId: user.id,
                    status: 'pending',
                });
                can(actions_enum_1.Action.Read, user_entity_1.User, { id: user.id });
                can(actions_enum_1.Action.Update, user_entity_1.User, { id: user.id });
                break;
            case enums_1.UserRole.READONLY:
                can(actions_enum_1.Action.Read, media_entity_1.Media);
                can(actions_enum_1.Action.Read, tag_entity_1.Tag);
                can(actions_enum_1.Action.Read, quality_profile_entity_1.QualityProfile);
                can(actions_enum_1.Action.Read, language_profile_entity_1.LanguageProfile);
                can(actions_enum_1.Action.Read, request_entity_1.SuitarrRequest, { userId: user.id });
                can(actions_enum_1.Action.Read, user_entity_1.User, { id: user.id });
                break;
        }
        return build();
    }
};
exports.CaslAbilityFactory = CaslAbilityFactory;
exports.CaslAbilityFactory = CaslAbilityFactory = __decorate([
    (0, common_1.Injectable)()
], CaslAbilityFactory);
//# sourceMappingURL=casl-ability.factory.js.map