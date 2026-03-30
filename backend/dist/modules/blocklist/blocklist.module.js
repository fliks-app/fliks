"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlocklistModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const blocklist_entry_entity_1 = require("./entities/blocklist-entry.entity");
const blocklist_service_1 = require("./blocklist.service");
const blocklist_controller_1 = require("./blocklist.controller");
const auth_module_1 = require("../auth/auth.module");
let BlocklistModule = class BlocklistModule {
};
exports.BlocklistModule = BlocklistModule;
exports.BlocklistModule = BlocklistModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([blocklist_entry_entity_1.BlocklistEntry]), auth_module_1.AuthModule],
        controllers: [blocklist_controller_1.BlocklistController],
        providers: [blocklist_service_1.BlocklistService],
        exports: [blocklist_service_1.BlocklistService],
    })
], BlocklistModule);
//# sourceMappingURL=blocklist.module.js.map