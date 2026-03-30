import { Strategy } from 'passport-http-header-strategy';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
declare const ApiKeyStrategy_base: new (...args: [options: import("passport-http-header-strategy").IStrategyOptions] | [] | [options: import("passport-http-header-strategy").IStrategyOptions]) => Strategy & {
    validate(...args: any[]): unknown;
};
export declare class ApiKeyStrategy extends ApiKeyStrategy_base {
    private readonly userRepo;
    constructor(userRepo: Repository<User>);
    validate(apiKey: string): Promise<User>;
}
export {};
