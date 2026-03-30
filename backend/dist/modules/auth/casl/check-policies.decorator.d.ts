import { AppAbility } from './casl-ability.factory';
export interface IPolicyHandler {
    handle(ability: AppAbility): boolean;
}
type PolicyHandlerCallback = (ability: AppAbility) => boolean;
export type PolicyHandler = IPolicyHandler | PolicyHandlerCallback;
export declare const CHECK_POLICIES_KEY = "check_policies";
export declare const CheckPolicies: (...handlers: PolicyHandler[]) => import("@nestjs/common").CustomDecorator<string>;
export {};
