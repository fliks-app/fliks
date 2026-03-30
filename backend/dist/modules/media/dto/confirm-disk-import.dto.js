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
exports.ConfirmDiskImportDto = exports.ImportFileEntry = void 0;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
class ImportFileEntry {
    filePath;
    mediaId;
    episodeId;
    quality;
}
exports.ImportFileEntry = ImportFileEntry;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ImportFileEntry.prototype, "filePath", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], ImportFileEntry.prototype, "mediaId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], ImportFileEntry.prototype, "episodeId", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], ImportFileEntry.prototype, "quality", void 0);
class ConfirmDiskImportDto {
    imports;
}
exports.ConfirmDiskImportDto = ConfirmDiskImportDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => ImportFileEntry),
    __metadata("design:type", Array)
], ConfirmDiskImportDto.prototype, "imports", void 0);
//# sourceMappingURL=confirm-disk-import.dto.js.map