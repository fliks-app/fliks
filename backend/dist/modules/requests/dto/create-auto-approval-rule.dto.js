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
exports.CreateAutoApprovalRuleDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
class ConditionDto {
    field;
    operator;
    value;
}
__decorate([
    (0, class_validator_1.IsIn)(['role', 'genre', 'year', 'seasons', 'userId']),
    __metadata("design:type", Object)
], ConditionDto.prototype, "field", void 0);
__decorate([
    (0, class_validator_1.IsIn)(['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains']),
    __metadata("design:type", Object)
], ConditionDto.prototype, "operator", void 0);
class CreateAutoApprovalRuleDto {
    name;
    enabled;
    conditions;
    priority;
}
exports.CreateAutoApprovalRuleDto = CreateAutoApprovalRuleDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAutoApprovalRuleDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsBoolean)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Boolean)
], CreateAutoApprovalRuleDto.prototype, "enabled", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => ConditionDto),
    __metadata("design:type", Array)
], CreateAutoApprovalRuleDto.prototype, "conditions", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Number)
], CreateAutoApprovalRuleDto.prototype, "priority", void 0);
//# sourceMappingURL=create-auto-approval-rule.dto.js.map