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
exports.IndexerStat = void 0;
const typeorm_1 = require("typeorm");
let IndexerStat = class IndexerStat {
    id;
    indexerId;
    queryDate;
    queryType;
    responseTimeMs;
    resultCount;
    errorMessage;
};
exports.IndexerStat = IndexerStat;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)(),
    __metadata("design:type", Number)
], IndexerStat.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", Number)
], IndexerStat.prototype, "indexerId", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], IndexerStat.prototype, "queryDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 'search' }),
    __metadata("design:type", String)
], IndexerStat.prototype, "queryType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], IndexerStat.prototype, "responseTimeMs", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], IndexerStat.prototype, "resultCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], IndexerStat.prototype, "errorMessage", void 0);
exports.IndexerStat = IndexerStat = __decorate([
    (0, typeorm_1.Entity)('indexer_stats')
], IndexerStat);
//# sourceMappingURL=indexer-stat.entity.js.map