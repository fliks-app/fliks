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
exports.SchedulerOrchestrator = void 0;
const common_1 = require("@nestjs/common");
const cron_1 = require("cron");
const scheduler_registry_1 = require("./scheduler.registry");
let SchedulerOrchestrator = class SchedulerOrchestrator {
    constructor(schedulerRegistry) {
        this.schedulerRegistry = schedulerRegistry;
        this.cronJobs = {};
        this.timeouts = {};
        this.intervals = {};
    }
    onApplicationBootstrap() {
        this.mountTimeouts();
        this.mountIntervals();
        this.mountCron();
    }
    beforeApplicationShutdown() {
        this.clearTimeouts();
        this.clearIntervals();
        this.closeCronJobs();
    }
    mountIntervals() {
        const intervalKeys = Object.keys(this.intervals);
        intervalKeys.forEach((key) => {
            const options = this.intervals[key];
            const intervalRef = setInterval(options.target, options.timeout);
            options.ref = intervalRef;
            this.schedulerRegistry.addInterval(key, intervalRef);
        });
    }
    mountTimeouts() {
        const timeoutKeys = Object.keys(this.timeouts);
        timeoutKeys.forEach((key) => {
            const options = this.timeouts[key];
            const timeoutRef = setTimeout(options.target, options.timeout);
            options.ref = timeoutRef;
            this.schedulerRegistry.addTimeout(key, timeoutRef);
        });
    }
    mountCron() {
        const cronKeys = Object.keys(this.cronJobs);
        cronKeys.forEach((key) => {
            const { options, target } = this.cronJobs[key];
            const cronJob = cron_1.CronJob.from({
                ...options,
                onTick: target,
                start: !options.disabled,
            });
            this.cronJobs[key].ref = cronJob;
            this.schedulerRegistry.addCronJob(key, cronJob);
        });
    }
    clearTimeouts() {
        this.schedulerRegistry
            .getTimeouts()
            .forEach((key) => this.schedulerRegistry.deleteTimeout(key));
    }
    clearIntervals() {
        this.schedulerRegistry
            .getIntervals()
            .forEach((key) => this.schedulerRegistry.deleteInterval(key));
    }
    closeCronJobs() {
        Array.from(this.schedulerRegistry.getCronJobs().keys()).forEach((key) => this.schedulerRegistry.deleteCronJob(key));
    }
    addTimeout(methodRef, timeout, name = crypto.randomUUID()) {
        this.timeouts[name] = {
            target: methodRef,
            timeout,
        };
    }
    addInterval(methodRef, timeout, name = crypto.randomUUID()) {
        this.intervals[name] = {
            target: methodRef,
            timeout,
        };
    }
    addCron(methodRef, options) {
        const name = options.name || crypto.randomUUID();
        this.cronJobs[name] = {
            target: methodRef,
            options,
        };
    }
};
exports.SchedulerOrchestrator = SchedulerOrchestrator;
exports.SchedulerOrchestrator = SchedulerOrchestrator = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [scheduler_registry_1.SchedulerRegistry])
], SchedulerOrchestrator);
