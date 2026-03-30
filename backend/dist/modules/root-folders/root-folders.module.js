"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RootFoldersModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const root_folder_entity_1 = require("./entities/root-folder.entity");
const root_folders_service_1 = require("./root-folders.service");
const root_folders_controller_1 = require("./root-folders.controller");
const auth_module_1 = require("../auth/auth.module");
let RootFoldersModule = class RootFoldersModule {
};
exports.RootFoldersModule = RootFoldersModule;
exports.RootFoldersModule = RootFoldersModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([root_folder_entity_1.RootFolder]), auth_module_1.AuthModule],
        controllers: [root_folders_controller_1.RootFoldersController],
        providers: [root_folders_service_1.RootFoldersService],
        exports: [root_folders_service_1.RootFoldersService],
    })
], RootFoldersModule);
//# sourceMappingURL=root-folders.module.js.map