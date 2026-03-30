"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var ScheduleModule_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScheduleModule = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const schedule_metadata_accessor_1 = require("./schedule-metadata.accessor");
const schedule_explorer_1 = require("./schedule.explorer");
const scheduler_orchestrator_1 = require("./scheduler.orchestrator");
const scheduler_registry_1 = require("./scheduler.registry");
const schedule_constants_1 = require("./schedule.constants");
/**
 * @publicApi
 */
let ScheduleModule = ScheduleModule_1 = class ScheduleModule {
    static forRoot(options) {
        const optionsWithDefaults = {
            cronJobs: true,
            intervals: true,
            timeouts: true,
            ...options,
        };
        return {
            global: true,
            module: ScheduleModule_1,
            providers: [
                schedule_explorer_1.ScheduleExplorer,
                scheduler_registry_1.SchedulerRegistry,
                {
                    provide: schedule_constants_1.SCHEDULE_MODULE_OPTIONS,
                    useValue: optionsWithDefaults,
                },
            ],
            exports: [scheduler_registry_1.SchedulerRegistry],
        };
    }
    static forRootAsync(options) {
        return {
            global: true,
            module: ScheduleModule_1,
            imports: options.imports || [],
            providers: [
                schedule_explorer_1.ScheduleExplorer,
                scheduler_registry_1.SchedulerRegistry,
                ...this.createAsyncProviders(options),
            ],
            exports: [scheduler_registry_1.SchedulerRegistry],
        };
    }
    static createAsyncProviders(options) {
        if (options.useExisting || options.useFactory) {
            return [this.createAsyncOptionsProvider(options)];
        }
        const useClass = options.useClass;
        return [
            this.createAsyncOptionsProvider(options),
            {
                provide: useClass,
                useClass: useClass,
            },
        ];
    }
    static createAsyncOptionsProvider(options) {
        if (options.useFactory) {
            return {
                provide: schedule_constants_1.SCHEDULE_MODULE_OPTIONS,
                useFactory: async (...args) => {
                    const config = await options.useFactory(...args);
                    return {
                        cronJobs: true,
                        intervals: true,
                        timeouts: true,
                        ...config,
                    };
                },
                inject: options.inject || [],
            };
        }
        const inject = [
            (options.useClass ||
                options.useExisting),
        ];
        return {
            provide: schedule_constants_1.SCHEDULE_MODULE_OPTIONS,
            useFactory: async (optionsFactory) => {
                const config = await optionsFactory.createScheduleOptions();
                return {
                    cronJobs: true,
                    intervals: true,
                    timeouts: true,
                    ...config,
                };
            },
            inject,
        };
    }
};
exports.ScheduleModule = ScheduleModule;
exports.ScheduleModule = ScheduleModule = ScheduleModule_1 = __decorate([
    (0, common_1.Module)({
        imports: [core_1.DiscoveryModule],
        providers: [schedule_metadata_accessor_1.SchedulerMetadataAccessor, scheduler_orchestrator_1.SchedulerOrchestrator],
    })
], ScheduleModule);
