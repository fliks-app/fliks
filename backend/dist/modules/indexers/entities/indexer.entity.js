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
exports.Indexer = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../../common/entities/base.entity");
const tag_entity_1 = require("../../tags/entities/tag.entity");
let Indexer = class Indexer extends base_entity_1.BaseEntity {
    name;
    implementation;
    settings;
    enableRss;
    enableSearch;
    priority;
    enabled;
    tags;
};
exports.Indexer = Indexer;
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Indexer.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Indexer.prototype, "implementation", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', default: {} }),
    __metadata("design:type", Object)
], Indexer.prototype, "settings", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], Indexer.prototype, "enableRss", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], Indexer.prototype, "enableSearch", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 25 }),
    __metadata("design:type", Number)
], Indexer.prototype, "priority", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], Indexer.prototype, "enabled", void 0);
__decorate([
    (0, typeorm_1.ManyToMany)(() => tag_entity_1.Tag, { eager: true }),
    (0, typeorm_1.JoinTable)({ name: 'indexer_tags' }),
    __metadata("design:type", Array)
], Indexer.prototype, "tags", void 0);
exports.Indexer = Indexer = __decorate([
    (0, typeorm_1.Entity)('indexers')
], Indexer);
//# sourceMappingURL=indexer.entity.js.map