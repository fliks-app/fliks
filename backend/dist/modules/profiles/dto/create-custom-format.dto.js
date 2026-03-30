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
exports.CreateCustomFormatDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
class SpecificationDto {
    name;
    implementation;
    negate;
    required;
    value;
}
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], SpecificationDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsIn)(['title_regex', 'source', 'resolution', 'language']),
    __metadata("design:type", String)
], SpecificationDto.prototype, "implementation", void 0);
__decorate([
    (0, class_validator_1.IsBoolean)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Boolean)
], SpecificationDto.prototype, "negate", void 0);
__decorate([
    (0, class_validator_1.IsBoolean)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Boolean)
], SpecificationDto.prototype, "required", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], SpecificationDto.prototype, "value", void 0);
class CreateCustomFormatDto {
    name;
    score;
    specifications;
}
exports.CreateCustomFormatDto = CreateCustomFormatDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateCustomFormatDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Number)
], CreateCustomFormatDto.prototype, "score", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => SpecificationDto),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Array)
], CreateCustomFormatDto.prototype, "specifications", void 0);
//# sourceMappingURL=create-custom-format.dto.js.map