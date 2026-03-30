import { SchedulerService } from './scheduler.service';
declare class TriggerCommandDto {
    name: string;
}
export declare class CommandsController {
    private readonly scheduler;
    constructor(scheduler: SchedulerService);
    list(): Promise<import("./entities/command.entity").Command[]>;
    trigger(dto: TriggerCommandDto): Promise<import("./entities/command.entity").Command>;
}
export {};
