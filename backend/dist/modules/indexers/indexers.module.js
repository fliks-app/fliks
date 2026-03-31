"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IndexersModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const indexer_entity_1 = require("./entities/indexer.entity");
const indexer_stat_entity_1 = require("./entities/indexer-stat.entity");
const tag_entity_1 = require("../tags/entities/tag.entity");
const torznab_service_1 = require("./torznab.service");
const indexers_service_1 = require("./indexers.service");
const indexers_controller_1 = require("./indexers.controller");
const auth_module_1 = require("../auth/auth.module");
let IndexersModule = class IndexersModule {
};
exports.IndexersModule = IndexersModule;
exports.IndexersModule = IndexersModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([indexer_entity_1.Indexer, indexer_stat_entity_1.IndexerStat, tag_entity_1.Tag]), auth_module_1.AuthModule],
        controllers: [indexers_controller_1.IndexersController],
        providers: [
            torznab_service_1.TorznabService,
            indexers_service_1.IndexersService,
        ],
        exports: [
            typeorm_1.TypeOrmModule,
            torznab_service_1.TorznabService,
        ],
    })
], IndexersModule);
//# sourceMappingURL=indexers.module.js.map