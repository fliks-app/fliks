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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScheduleExplorer = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const scheduler_type_enum_1 = require("./enums/scheduler-type.enum");
const schedule_metadata_accessor_1 = require("./schedule-metadata.accessor");
const scheduler_orchestrator_1 = require("./scheduler.orchestrator");
const schedule_constants_1 = require("./schedule.constants");
let ScheduleExplorer = class ScheduleExplorer {
    constructor(moduleOptions, schedulerOrchestrator, discoveryService, metadataAccessor, metadataScanner) {
        this.moduleOptions = moduleOptions;
        this.schedulerOrchestrator = schedulerOrchestrator;
        this.discoveryService = discoveryService;
        this.metadataAccessor = metadataAccessor;
        this.metadataScanner = metadataScanner;
        this.logger = new common_1.Logger('Scheduler');
    }
    onModuleInit() {
        this.explore();
    }
    explore() {
        const instanceWrappers = [
            ...this.discoveryService.getControllers(),
            ...this.discoveryService.getProviders(),
        ];
        instanceWrappers.forEach((wrapper) => {
            const { instance } = wrapper;
            if (!instance || !Object.getPrototypeOf(instance)) {
                return;
            }
            const processMethod = (name) => wrapper.isDependencyTreeStatic()
                ? this.lookupSchedulers(instance, name)
                : this.warnForNonStaticProviders(wrapper, instance, name);
            // TODO(v4): remove this after dropping support for nestjs v9.3.2
            if (!Reflect.has(this.metadataScanner, 'getAllMethodNames')) {
                this.metadataScanner.scanFromPrototype(instance, Object.getPrototypeOf(instance), processMethod);
                return;
            }
            this.metadataScanner
                .getAllMethodNames(Object.getPrototypeOf(instance))
                .forEach(processMethod);
        });
    }
    lookupSchedulers(instance, key) {
        const methodRef = instance[key];
        const metadata = this.metadataAccessor.getSchedulerType(methodRef);
        switch (metadata) {
            case scheduler_type_enum_1.SchedulerType.CRON: {
                if (!this.moduleOptions.cronJobs) {
                    return;
                }
                const cronMetadata = this.metadataAccessor.getCronMetadata(methodRef);
                const cronFn = this.wrapFunctionInTryCatchBlocks(methodRef, instance);
                return this.schedulerOrchestrator.addCron(cronFn, cronMetadata);
            }
            case scheduler_type_enum_1.SchedulerType.TIMEOUT: {
                if (!this.moduleOptions.timeouts) {
                    return;
                }
                const timeoutMetadata = this.metadataAccessor.getTimeoutMetadata(methodRef);
                const name = this.metadataAccessor.getSchedulerName(methodRef);
                const timeoutFn = this.wrapFunctionInTryCatchBlocks(methodRef, instance);
                return this.schedulerOrchestrator.addTimeout(timeoutFn, timeoutMetadata.timeout, name);
            }
            case scheduler_type_enum_1.SchedulerType.INTERVAL: {
                if (!this.moduleOptions.intervals) {
                    return;
                }
                const intervalMetadata = this.metadataAccessor.getIntervalMetadata(methodRef);
                const name = this.metadataAccessor.getSchedulerName(methodRef);
                const intervalFn = this.wrapFunctionInTryCatchBlocks(methodRef, instance);
                return this.schedulerOrchestrator.addInterval(intervalFn, intervalMetadata.timeout, name);
            }
        }
    }
    warnForNonStaticProviders(wrapper, instance, key) {
        const methodRef = instance[key];
        const metadata = this.metadataAccessor.getSchedulerType(methodRef);
        switch (metadata) {
            case scheduler_type_enum_1.SchedulerType.CRON: {
                if (!this.moduleOptions.cronJobs) {
                    return;
                }
                this.logger.warn(`Cannot register cron job "${wrapper.name}@${key}" because it is defined in a non static provider.`);
                break;
            }
            case scheduler_type_enum_1.SchedulerType.TIMEOUT: {
                if (!this.moduleOptions.timeouts) {
                    return;
                }
                this.logger.warn(`Cannot register timeout "${wrapper.name}@${key}" because it is defined in a non static provider.`);
                break;
            }
            case scheduler_type_enum_1.SchedulerType.INTERVAL: {
                if (!this.moduleOptions.intervals) {
                    return;
                }
                this.logger.warn(`Cannot register interval "${wrapper.name}@${key}" because it is defined in a non static provider.`);
                break;
            }
        }
    }
    wrapFunctionInTryCatchBlocks(methodRef, instance) {
        return async (...args) => {
            try {
                await methodRef.call(instance, ...args);
            }
            catch (error) {
                this.logger.error(error);
            }
        };
    }
};
exports.ScheduleExplorer = ScheduleExplorer;
exports.ScheduleExplorer = ScheduleExplorer = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(schedule_constants_1.SCHEDULE_MODULE_OPTIONS)),
    __metadata("design:paramtypes", [Object, scheduler_orchestrator_1.SchedulerOrchestrator,
        core_1.DiscoveryService,
        schedule_metadata_accessor_1.SchedulerMetadataAccessor,
        core_1.MetadataScanner])
], ScheduleExplorer);
