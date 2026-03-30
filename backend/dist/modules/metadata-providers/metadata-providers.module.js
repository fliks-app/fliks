"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetadataProvidersModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const tmdb_provider_1 = require("./providers/tmdb.provider");
const metadata_providers_controller_1 = require("./metadata-providers.controller");
const media_entity_1 = require("../media/entities/media.entity");
const auth_module_1 = require("../auth/auth.module");
let MetadataProvidersModule = class MetadataProvidersModule {
};
exports.MetadataProvidersModule = MetadataProvidersModule;
exports.MetadataProvidersModule = MetadataProvidersModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([media_entity_1.Media]), auth_module_1.AuthModule],
        controllers: [metadata_providers_controller_1.MetadataProvidersController],
        providers: [tmdb_provider_1.TmdbProvider],
        exports: [tmdb_provider_1.TmdbProvider],
    })
], MetadataProvidersModule);
//# sourceMappingURL=metadata-providers.module.js.map